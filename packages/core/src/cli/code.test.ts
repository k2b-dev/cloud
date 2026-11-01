import { afterAll, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, readFile, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudCliContext, CloudCliFlags, CloudCliOutputMode } from "@k2b/cloud/cli";
import { codeTestFailure } from "@k2b/cloud/code";
import type { CodeAuthoringData, CodeProject } from "../code/authoring-contracts";
import { codePolicyPreset } from "../code/policy-contracts";
import code from "./code";
import { codeProjectFolder, listCodeProjects, loadCodeProject, readCodeFiles, writeCodeProject } from "./code-files";

const uuid = "11111111-1111-4111-8111-111111111111";
const config: CodeProject = {
  version: 1,
  codeId: "c_1234",
  title: "Invoices",
  owner: { kind: "resource", ref: { type: "example.box", id: "box_1234" } },
  entry: "code.ts",
  baseVersionId: uuid,
};
const source = "export const monday = 1;\n";
const checked: CodeAuthoringData<"check"> = {
  version: 1,
  result: {
    ok: true,
    diagnostics: [],
    bundle: "checked bundle",
    manifest: {
      version: 1,
      entrypoints: [],
      permissions: [],
      ai: true,
      hashes: { source: "a".repeat(64), sdk: "b".repeat(64), bundle: "c".repeat(64) },
    },
    permissions: [],
  },
  manifest: {
    version: 1,
    entry: "code.ts",
    entrypoints: [],
    permissions: [],
    ai: true,
    hashes: { source: "a".repeat(64), sdk: "b".repeat(64), bundle: "c".repeat(64) },
    policyRows: ["ai"],
  },
  permissions: [
    {
      operation: "example.conversation.move",
      target: { type: "example.box", id: "box_1234" },
      title: "Rechnungen",
      typeTitle: "Postfach",
      file: "code.ts",
      line: 3,
      own: true,
      needsTargetAdmin: false,
      status: "existing",
    },
    {
      operation: "other.task.create",
      target: { type: "other.space", id: "sp_4kd2" },
      title: "Buchhaltung",
      typeTitle: "Space",
      file: "code.ts",
      line: 8,
      own: false,
      needsTargetAdmin: true,
      status: "new",
    },
  ],
};
const dirs: string[] = [];
async function removeFixture(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await removeFixture(path);
    else await unlink(path);
  }
  await rmdir(directory);
}
afterAll(async () => {
  for (const directory of dirs) await removeFixture(directory);
});
async function project() {
  const root = await mkdtemp(join(tmpdir(), "cloud-code-c18a-"));
  dirs.push(root);
  const directory = await writeCodeProject(root, config, { "code.ts": source });
  return { root, directory };
}
function context(
  args: string[],
  flags: CloudCliFlags = {},
  output: CloudCliOutputMode = "json",
  respond: (path: string, input: Record<string, unknown>) => Response = () => Response.json(checked),
) {
  const printed: unknown[] = [],
    errors: string[] = [],
    requests: { path: string; input: Record<string, unknown> }[] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "fixture", server: "https://cloud.test", token: "fixture", output, locale: "de" },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("unused");
    },
    fetch: async (path, init) => {
      const input: Record<string, unknown> = JSON.parse(String(init?.body));
      requests.push({ path, input });
      return respond(path, input);
    },
    readJson: async (response) => response.json(),
    print: (text) => {
      printed.push(text);
    },
    write: async (text) => {
      printed.push(text);
    },
    error: (text) => {
      errors.push(text);
    },
    json: (value) => {
      printed.push(value);
    },
    jsonLine: (value) => {
      printed.push(value);
    },
    table: () => {
      throw new Error("unused");
    },
  };
  return { ctx, printed, requests, errors };
}
test("check prints chapter 11 permissions with exact targets and source lines", async () => {
  const { directory } = await project();
  const run = context(["check", directory], {}, "text");
  expect(await code.run(run.ctx)).toBe(0);
  expect(run.printed.join("\n")).toMatchInlineSnapshot(`
"Erlaubnisse
  example.conversation.move   am eigenen Postfach Rechnungen (box_1234)   code.ts:3
  other.task.create           an Space Buchhaltung (sp_4kd2)   code.ts:8  ← neu, braucht den Admin des Space
KI           ja
Seiten       —
Webhook      —
Datenbank    —"
`);
  expect(run.requests[0]?.input).toEqual({ codeId: config.codeId, entry: "code.ts", files: { "code.ts": source } });
});
test.each(["json", "jsonl"] as const)("check %s remains identical across invocations and locales", async (mode) => {
  const { directory } = await project();
  const first = context(["check", directory], {}, mode),
    second = context(["check", directory], {}, mode);
  second.ctx.options.locale = "en";
  await code.run(first.ctx);
  await code.run(second.ctx);
  expect(first.printed).toEqual([checked]);
  expect(second.printed).toEqual(first.printed);
  expect(first.errors).toEqual([]);
});
test("failed check preserves diagnostics and exits one", async () => {
  const { directory } = await project();
  const result = {
    version: 1,
    result: { ok: false, diagnostics: [{ code: "TS2304", message: "Missing name", file: "code.ts", line: 1, column: 1 }] },
    manifest: null,
    permissions: [],
  };
  const run = context(["check", directory], {}, "json", () => Response.json(result));
  expect(await code.run(run.ctx)).toBe(1);
  expect(run.printed).toEqual([result]);
});
test("stale push preserves the local base and returns the complete version conflict", async () => {
  const { directory } = await project();
  const failure = {
    version: 1,
    error: {
      code: "code_version_conflict",
      message: "Neuere Version vorhanden.",
      details: {
        latestVersionId: uuid,
        files: [
          {
            path: "code.ts",
            lines: [
              { kind: "del", text: "old" },
              { kind: "add", text: "new" },
            ],
          },
        ],
      },
    },
  };
  const machine = context(["push", directory], {}, "json", () => Response.json(failure, { status: 409 }));
  expect(await code.run(machine.ctx)).toBe(1);
  expect(machine.printed).toEqual([failure]);
  expect(machine.requests[0]?.input.baseVersionId).toBe(uuid);
  expect((await loadCodeProject(directory)).config.baseVersionId).toBe(uuid);
  const human = context(["push", directory], {}, "text", () => Response.json(failure, { status: 409 }));
  expect(await code.run(human.ctx)).toBe(1);
  expect(human.errors[0]).toContain("Neuere Version vorhanden");
  expect(human.printed).toEqual(["--- code.ts", "-old", "+new"]);
});
test("activation without confirmation, in CI, or refused by server never reports success", async () => {
  const { directory } = await project();
  const missing = context(["activate", directory], { "activation-id": uuid });
  expect(await code.run(missing.ctx)).toBe(1);
  expect(missing.requests).toEqual([]);
  const ci = context(["activate", directory], { yes: true, "activation-id": uuid });
  ci.ctx.options.ci = true;
  expect(await code.run(ci.ctx)).toBe(1);
  expect(ci.requests).toEqual([]);
  const failure = { version: 1, error: { code: "FORBIDDEN", message: "Phone sessions cannot activate.", details: null } };
  const denied = context(["activate", directory], { yes: true, "activation-id": uuid }, "json", () =>
    Response.json(failure, { status: 403 }),
  );
  expect(await code.run(denied.ctx)).toBe(1);
  expect(denied.printed).toEqual([failure]);
});
test("test and simulation keep the C17 result and failing exit status", async () => {
  const { directory } = await project();
  const fixture = { version: 1, name: "monday", now: 1793448000000, seed: 7, mocks: [], runs: [{ entrypoint: "monday" }] };
  await writeFile(join(directory, "fixture.json"), JSON.stringify(fixture));
  for (const mode of ["test", "simulate"] as const) {
    const failure = codeTestFailure(mode, "code_test_runner_unavailable");
    const run = context([mode, directory], mode === "simulate" ? { fixture: "fixture.json" } : {}, "json", () => Response.json(failure));
    expect(await code.run(run.ctx)).toBe(1);
    expect(run.printed).toEqual([failure]);
  }
});
test("pull creates ID folders and refuses to overwrite unsaved edits", async () => {
  const { root, directory } = await project();
  const run = context(["pull", config.codeId], { out: root }, "json", () =>
    Response.json({ version: 1, config, files: { "code.ts": "remote" } }),
  );
  expect(await code.run(run.ctx)).toBe(1);
  expect(await readFile(join(directory, "code.ts"), "utf8")).toBe(source);
  expect(codeProjectFolder({ ...config, title: "mail@example.test / changed title" })).toBe("example/box_1234");
  expect(codeProjectFolder({ ...config, owner: { kind: "resource", ref: { type: "example.box", id: "../escape" } } })).toBe(
    "example/@c_1234",
  );
});
test("local source never follows links or includes generated SDK/test code", async () => {
  const { directory, root } = await project();
  await writeCodeProject(root, { ...config, owner: { kind: "person", userId: uuid } }, {});
  await symlink(join(directory, "code.ts"), join(directory, "linked.ts"));
  await expect(readCodeFiles(directory)).rejects.toThrow("Symbolic link");
  expect((await lstat(join(directory, "linked.ts"))).isSymbolicLink()).toBe(true);
});
test("help never performs an operation and lists every C18a command", async () => {
  const run = context(["help"], {}, "text");
  await code.run(run.ctx);
  expect(run.requests).toEqual([]);
  for (const name of ["init", "sdk", "check", "test", "simulate", "pull", "push", "submit", "diff", "activate", "run"])
    expect(run.printed.join("\n")).toContain(name);
});

test.each(["text", "json", "jsonl"] as const)("all lifecycle commands honor %s output and preserve their contracts", async (output) => {
  const { root, directory } = await project();
  const createdAt = "2026-10-31T12:00:00.000Z";
  const binding = {
    codeId: config.codeId,
    versionId: uuid,
    sourceHash: "a".repeat(64),
    bundleHash: "b".repeat(64),
    manifestHash: "c".repeat(64),
    comparisonVersionId: null,
    comparisonSourceHash: null,
    comparisonBundleHash: null,
  };
  const submission = {
    version: {
      id: uuid,
      codeId: config.codeId,
      number: 1,
      sourceHash: binding.sourceHash,
      bundleHash: binding.bundleHash,
      files: ["code.ts"],
      sourceBytes: source.length,
      bundleBytes: 1,
      manifestAvailable: true,
      createdBy: uuid,
      createdAt,
    },
    binding,
    status: "submitted",
    approvalId: null,
    decision: null,
  };
  const records: Array<{ args: string[]; flags: CloudCliFlags; data: unknown; text: string }> = [
    {
      args: ["init"],
      flags: { title: config.title, out: join(root, "init") },
      data: { version: 1, config, files: { "code.ts": source } },
      text: `${config.codeId} angelegt. Führe dort sdk pull aus.`,
    },
    {
      args: ["pull", config.codeId],
      flags: { out: join(root, "pull") },
      data: { version: 1, config, files: { "code.ts": source } },
      text: `${config.codeId} auf Stand ${uuid} geholt.`,
    },
    {
      args: ["sdk", "pull", directory],
      flags: {},
      data: {
        version: 1,
        files: {
          "sdk/sdk.d.ts": "declare const app: unknown;",
          "sdk/sdk.js": "export {};",
          "sdk/manifest.json": "{}",
          "tsconfig.json": "{}",
        },
      },
      text: "SDK aktualisiert.",
    },
    { args: ["push", directory], flags: {}, data: { version: 1, submission }, text: `${uuid} · submitted` },
    { args: ["submit", directory], flags: {}, data: { version: 1, submission }, text: `${uuid} · submitted` },
    {
      args: ["diff", directory],
      flags: {},
      data: {
        version: 1,
        diff: {
          binding,
          staleComparison: false,
          files: [{ path: "code.ts", lines: [{ kind: "add", text: "new" }] }],
          permissions: [],
          secrets: [],
          policyRows: [],
        },
      },
      text: "--- code.ts\n+new",
    },
    {
      args: ["activate", directory],
      flags: { yes: true, "activation-id": uuid },
      data: {
        version: 1,
        activation: {
          id: uuid,
          codeId: config.codeId,
          versionId: uuid,
          state: "pending",
          failure: null,
          mandateId: null,
          createdAt,
          updatedAt: createdAt,
        },
      },
      text: `${uuid} · pending`,
    },
    {
      args: ["run", "monday", directory],
      flags: { key: "fixture-start" },
      data: { version: 1, run: { runId: uuid, duplicate: false } },
      text: uuid,
    },
  ];
  for (const record of records) {
    const run = context(record.args, record.flags, output, () => Response.json(record.data));
    run.ctx.options.ci = false;
    const exit = await code.run(run.ctx);
    expect(exit, JSON.stringify({ command: record.args, errors: run.errors, output: run.printed })).not.toBe(1);
    expect(run.errors).toEqual([]);
    if (output === "text") expect(run.printed.join("\n")).toBe(record.text);
    else expect(run.printed).toEqual([record.data]);
  }
});

test("personal check never asks for target-admin grants", async () => {
  const { directory } = await project();
  const personal = {
    ...checked,
    permissions: checked.permissions.map((permission) => ({ ...permission, own: false, needsTargetAdmin: false })),
  };
  const run = context(["check", directory], {}, "text", () => Response.json(personal));
  expect(await code.run(run.ctx)).toBe(0);
  expect(run.printed.join("\n")).toMatchInlineSnapshot(`
"Erlaubnisse
  example.conversation.move   an Postfach Rechnungen (box_1234)   code.ts:3
  other.task.create           an Space Buchhaltung (sp_4kd2)   code.ts:8
KI           ja
Seiten       —
Webhook      —
Datenbank    —"
`);
});

test("init preflights existing and unsafe resource destinations before creating remote Code", async () => {
  const { root } = await project();
  for (const ownerId of ["box_1234", "../escape"]) {
    const run = context(["init"], { title: "New", out: root, "owner-type": "example.box", "owner-id": ownerId });
    expect(await code.run(run.ctx)).toBe(1);
    expect(run.requests).toEqual([]);
  }
});

test("init reports the created Code config when a local checkout fails after the response", async () => {
  const { root } = await project();
  const personal: CodeProject = { ...config, owner: { kind: "person", userId: uuid } };
  await writeCodeProject(root, personal, { "code.ts": source });
  // Personal folders use the server-generated Code ID, which is unknown before the request.
  const run = context(["init"], { title: config.title, out: root }, "json", () =>
    Response.json({ version: 1, config: personal, files: { "code.ts": source } }),
  );
  expect(await code.run(run.ctx)).toBe(1);
  expect(run.requests).toHaveLength(1);
  expect(run.printed).toEqual([
    {
      version: 1,
      error: {
        code: "code_cli_checkout_failed",
        message: `${config.codeId} angelegt, aber lokal konnte das Projekt nicht geschrieben werden. Hole diese Code-ID mit pull in ein neues Verzeichnis.`,
        details: { config: personal },
      },
    },
  ]);
});

test("nested source directories named test or build survive pull and push collection", async () => {
  const { root, directory } = await project();
  await mkdir(join(directory, "lib", "test"), { recursive: true });
  await mkdir(join(directory, "lib", "build"), { recursive: true });
  await mkdir(join(directory, "test"));
  await writeFile(join(directory, "lib", "test", "helpers.ts"), "export const helper = 1;");
  await writeFile(join(directory, "lib", "build", "source.tsx"), "export const source = 2;");
  await writeFile(join(directory, "test", "fixture.ts"), "excluded root test code");
  const files = await readCodeFiles(directory);
  expect(files).toEqual({
    "code.ts": source,
    "lib/build/source.tsx": "export const source = 2;",
    "lib/test/helpers.ts": "export const helper = 1;",
  });
  const pulled = await writeCodeProject(join(root, "fresh"), config, files);
  expect(await readCodeFiles(pulled)).toEqual(files);
});

test.each(["diff", "activate"])("%s explains a missing base without sending an invalid version", async (command) => {
  const { root } = await project();
  const directory = await writeCodeProject(join(root, "unsaved"), { ...config, baseVersionId: null }, { "code.ts": source });
  const run = context([command, directory], command === "activate" ? { yes: true, "activation-id": uuid } : {});
  expect(await code.run(run.ctx)).toBe(1);
  expect(run.requests).toEqual([]);
  expect(run.printed).toEqual([
    { version: 1, error: { code: "code_cli_input", message: "Keine gespeicherte Version. Führe zuerst push aus.", details: null } },
  ]);
});

const serverCode = {
  id: config.codeId,
  owner: config.owner,
  title: config.title,
  serviceAccountId: uuid,
  state: "paused",
  activeVersionId: uuid,
  pauseReason: "manual",
  pauseRows: [],
  pausePolicyRevision: null,
  createdBy: uuid,
  createdAt: "2026-10-31T12:00:00.000Z",
};
const runMetadata = {
  id: uuid,
  codeId: config.codeId,
  versionId: uuid,
  trigger: "manual",
  entrypoint: "monday",
  state: "failed",
  outcome: "lease_lost",
  createdAt: serverCode.createdAt,
  startedAt: serverCode.createdAt,
  endedAt: serverCode.createdAt,
};
const secretMetadata = {
  name: "BANK_TOKEN",
  origin: "https://bank.example",
  pathPrefix: "/api",
  headers: ["authorization"],
  binding_revision: uuid,
  configured: true,
};
test.each(["json", "jsonl"] as const)("C18b %s success contracts remain unchanged across locales", async (output) => {
  const { root, directory } = await project();
  const policy = { revision: 3, definition: codePolicyPreset("admin"), updatedBy: uuid, updatedAt: serverCode.createdAt };
  const records: Array<{ args: string[]; flags: CloudCliFlags; data: unknown; key: string }> = [
    {
      args: ["status", root],
      flags: {},
      data: {
        version: 1,
        items: [{ code: serverCode, permission: "editor", baseVersionId: uuid, baseCurrent: true, modified: false, latest: null }],
      },
      key: "status",
    },
    { args: ["runs", directory], flags: {}, data: { version: 1, items: [runMetadata], nextCursor: "next" }, key: "runs" },
    { args: ["runs", directory], flags: { run: uuid }, data: { version: 1, run: runMetadata, contents: null }, key: "runRead" },
    { args: ["pause", directory], flags: { yes: true }, data: { version: 1, state: "paused" }, key: "pause" },
    { args: ["resume", directory], flags: { yes: true }, data: { version: 1, state: "active" }, key: "resume" },
    { args: ["policy", "read"], flags: {}, data: { version: 1, policy }, key: "policyRead" },
    {
      args: ["policy", "effective"],
      flags: {},
      data: { version: 1, revision: 3, rows: [{ row: "read", value: "automatic", source: "default", groupIds: [] }] },
      key: "policyEffective",
    },
    {
      args: ["policy", "preview"],
      flags: { revision: "3", preset: "admin" },
      data: { version: 1, revision: 3, total: 0, items: [], nextCursor: null },
      key: "policyPreview",
    },
    {
      args: ["policy", "update"],
      flags: { revision: "3", preset: "admin", yes: true },
      data: { version: 1, policy, pauseJobId: uuid },
      key: "policyUpdate",
    },
    {
      args: ["secret", "list", directory],
      flags: {},
      data: { version: 1, items: [{ ...secretMetadata, valueSetBy: null, valueSetAt: null }], nextCursor: "NEXT" },
      key: "secretList",
    },
    {
      args: ["secret", "delete", "BANK_TOKEN", directory],
      flags: { "binding-revision": uuid, yes: true },
      data: { version: 1, deleted: true },
      key: "secretDelete",
    },
  ];
  for (const record of records) {
    for (const locale of ["de", "en"]) {
      const invocation = context(record.args, record.flags, output, () => Response.json(record.data));
      invocation.ctx.options.locale = locale;
      expect(await code.run(invocation.ctx)).toBe(0);
      expect(invocation.printed).toEqual([record.data]);
      expect(invocation.requests[0]?.path).toBe(`/api/code/authoring/${record.key}`);
    }
  }
});
test("status scans all project folders, excludes generated files and rejects duplicate IDs", async () => {
  const { root, directory } = await project();
  await writeCodeProject(root, { ...config, codeId: "c_5678", owner: { kind: "person", userId: uuid } }, { "code.ts": "second" });
  expect((await listCodeProjects(root)).map((project) => project.config.codeId)).toEqual(["c_1234", "c_5678"]);
  await mkdir(join(directory, "sdk"));
  await writeFile(join(directory, "sdk", "ignore.ts"), "generated");
  expect(await readCodeFiles(directory)).toEqual({ "code.ts": source });
  await writeCodeProject(join(root, "duplicate"), config, {});
  await expect(listCodeProjects(root)).rejects.toThrow("Duplicate");
});
test("pull --all walks empty cursor pages, writes short-ID layouts and prints one aggregate", async () => {
  const { root } = await project();
  const out = join(root, "all");
  let calls = 0;
  const pulled = { version: 1, config, files: { "code.ts": source } };
  const invocation = context(["pull"], { all: true, out }, "json", (_path, input) => {
    calls++;
    if (calls === 1) return Response.json({ version: 1, items: [], nextCursor: "c_1111" });
    expect(input.cursor).toBe("c_1111");
    return Response.json({ version: 1, items: [pulled], nextCursor: null });
  });
  expect(await code.run(invocation.ctx)).toBe(0);
  expect(invocation.printed.join("")).toBe(JSON.stringify({ version: 1, items: [pulled], nextCursor: null }, null, 2) + "\n");
  expect(await readFile(join(out, "example", "box_1234", "code.ts"), "utf8")).toBe(source);
  expect(await code.run(invocation.ctx)).toBe(1); // Existing source is never overwritten.
});
test("stale policy revision fails once with no automatic reread or replacement", async () => {
  const failure = { version: 1, error: { code: "CONFLICT", message: "Code policy changed; read and preview it again.", details: null } };
  for (const verb of ["preview", "update"]) {
    const invocation = context(
      ["policy", verb],
      { revision: "3", preset: "open", ...(verb === "update" ? { yes: true } : {}) },
      "json",
      () => Response.json(failure, { status: 409 }),
    );
    expect(await code.run(invocation.ctx)).toBe(1);
    expect(invocation.printed).toEqual([failure]);
    expect(invocation.requests).toHaveLength(1);
    expect(invocation.requests[0]?.input).toMatchObject({ revision: 3, definition: codePolicyPreset("open") });
  }
});
test("runs retain reader redaction and paginate ordered call metadata", async () => {
  const { directory } = await project();
  const reader = context(["runs", directory], { run: uuid }, "text", () => Response.json({ version: 1, run: runMetadata, contents: null }));
  expect(await code.run(reader.ctx)).toBe(0);
  expect(reader.printed.join("\n")).toMatchInlineSnapshot(`
"11111111-1111-4111-8111-111111111111 · failed · Runner-Verbindung verloren. Prüfe die gespeicherten Aufrufe vor der erneuten Ausführung.
Laufinhalte erfordern Bearbeitungsrechte."
`);
  const contents = {
    input: null,
    output: null,
    inputChunked: false,
    outputChunked: false,
    content: null,
    calls: [
      {
        ordinal: 2,
        kind: "action",
        capability: "example.task.create",
        call: null,
        result: null,
        callChunked: true,
        resultChunked: true,
        state: "uncertain",
        startedAt: serverCode.createdAt,
        endedAt: null,
      },
    ],
    nextCursor: 2,
  };
  const editor = context(["runs", directory], { run: uuid, "call-cursor": "1" }, "json", () =>
    Response.json({ version: 1, run: runMetadata, contents }),
  );
  expect(await code.run(editor.ctx)).toBe(0);
  expect(editor.requests[0]?.input.cursor).toBe(1);
  expect(editor.printed).toEqual([{ version: 1, run: runMetadata, contents }]);
});
test("secret file values never enter argv, output or error details, even when remote errors echo them", async () => {
  const { root, directory } = await project();
  const privateValue = "fixture-private-bank-credential";
  const privateFile = join(root, "secret-input");
  await writeFile(privateFile, privateValue + "\n", { mode: 0o600 });
  const flags = { from: privateFile, "binding-revision": uuid };
  for (const output of ["text", "json", "jsonl"] as const) {
    const invocation = context(["secret", "set", "BANK_TOKEN", directory], flags, output, () =>
      Response.json({ version: 1, secret: secretMetadata }),
    );
    expect(await code.run(invocation.ctx)).toBe(0);
    expect(invocation.requests[0]?.input.value).toBe(privateValue);
    expect(JSON.stringify([invocation.ctx.args, invocation.ctx.flags, invocation.printed, invocation.errors])).not.toContain(privateValue);
    const denied = context(["secret", "set", "BANK_TOKEN", directory], flags, output, () =>
      Response.json(
        { version: 1, error: { code: privateValue, message: privateValue, details: { value: privateValue } } },
        { status: 409 },
      ),
    );
    expect(await code.run(denied.ctx)).toBe(1);
    expect(JSON.stringify([denied.printed, denied.errors])).not.toContain(privateValue);
  }
  const invalid = context(["secret", "set", "BANK_TOKEN", directory, privateValue], flags);
  expect(await code.run(invalid.ctx)).toBe(1);
  expect(invalid.requests).toEqual([]);
  expect(JSON.stringify([invalid.printed, invalid.errors])).not.toContain(privateValue);
  const inline = context(["secret", "set", "BANK_TOKEN", directory], { ...flags, value: privateValue });
  expect(await code.run(inline.ctx)).toBe(1);
  expect(inline.requests).toEqual([]);
});
test("secret stdin is consumed privately by a child process, with no value in its argv", async () => {
  const { root, directory } = await project();
  const script = join(root, "stdin-driver.ts");
  await writeFile(
    script,
    `import code from ${JSON.stringify(import.meta.dir + "/code.ts")};
const printed = [];
const ctx = { args: ["secret", "set", "BANK_TOKEN", ${JSON.stringify(directory)}], flags: { from: "-", "binding-revision": ${JSON.stringify(uuid)} }, options: {output:"json",locale:"en"},
fetch: async (_path, init) => { const input = JSON.parse(init.body); if (!input.value || input.value.includes("\\n")) throw new Error("bad private input"); return Response.json({ version:1, secret:${JSON.stringify(secretMetadata)} }); },
json: value => printed.push(value), error: value => printed.push(value), print: value => printed.push(value) };
const exit = await code.run(ctx); console.log(JSON.stringify({exit,printed}));`,
  );
  const child = Bun.spawn([process.execPath, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write("fixture-stdin-credential\n");
  child.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).not.toContain("fixture-stdin-credential");
  expect(JSON.parse(stdout)).toEqual({ exit: 0, printed: [{ version: 1, secret: secretMetadata }] });
});
test.each(["pause", "resume", "secret-delete", "policy-update"])("%s refuses an unconfirmed mutation", async (name) => {
  const { directory } = await project();
  const args =
    name === "secret-delete"
      ? ["secret", "delete", "BANK_TOKEN", directory]
      : name === "policy-update"
        ? ["policy", "update"]
        : [name, directory];
  const invocation = context(
    args,
    name === "secret-delete" ? { "binding-revision": uuid } : name === "policy-update" ? { revision: "3", preset: "open" } : {},
  );
  expect(await code.run(invocation.ctx)).toBe(1);
  expect(invocation.requests).toEqual([]);
});
test("C18b command help has every operation and never reads private input", async () => {
  for (const args of [["help"], ["secret", "set", "help"], ["policy", "help"], ["runs", "help"]]) {
    const invocation = context(args, {}, "text");
    expect(await code.run(invocation.ctx)).toBe(0);
    expect(invocation.requests).toEqual([]);
  }
  const invocation = context(["help"], {}, "text");
  await code.run(invocation.ctx);
  for (const name of ["status", "runs", "pause", "resume", "policy", "secret"]) expect(invocation.printed.join("\n")).toContain(name);
});

test("CI may pause but cannot resume execution", async () => {
  const { directory } = await project();
  const invocation = context(["resume", directory], { yes: true });
  invocation.ctx.options.ci = true;
  expect(await code.run(invocation.ctx)).toBe(1);
  expect(invocation.requests).toEqual([]);
  expect(invocation.printed).toEqual([
    { version: 1, error: { code: "code_cli_input", message: "CI darf Code pushen, aber nie fortsetzen.", details: null } },
  ]);
});
test("status finds the surrounding project from nested source paths", async () => {
  const { directory } = await project();
  await mkdir(join(directory, "lib"));
  await writeFile(join(directory, "lib", "module.ts"), "export {};");
  for (const path of [directory, join(directory, "lib"), join(directory, "lib", "module.ts")]) {
    expect((await listCodeProjects(path)).map((project) => project.config.codeId)).toEqual([config.codeId]);
  }
});
test("missing pull ID gets an actionable input error instead of a schema dump", async () => {
  const invocation = context(["pull"]);
  expect(await code.run(invocation.ctx)).toBe(1);
  expect(invocation.requests).toEqual([]);
  expect(invocation.printed).toEqual([
    { version: 1, error: { code: "code_cli_input", message: "Gib eine Code-ID oder --all an.", details: null } },
  ]);
});
test("private input files can be selected through symlinks without weakening workspace checks", async () => {
  const { root, directory } = await project();
  const privateFile = join(root, "private-value");
  const linked = join(root, "mounted-value");
  await writeFile(privateFile, "private-mounted-credential", { mode: 0o600 });
  await symlink(privateFile, linked);
  const invocation = context(["secret", "set", "BANK_TOKEN", directory], { from: linked, "binding-revision": uuid }, "json", () =>
    Response.json({ version: 1, secret: secretMetadata }),
  );
  expect(await code.run(invocation.ctx)).toBe(0);
  expect(invocation.requests[0]?.input.value).toBe("private-mounted-credential");
  expect(JSON.stringify(invocation.printed)).not.toContain("private-mounted-credential");
});
test("pull --all stages one valid JSON value and discards it on a later failure", async () => {
  const { root } = await project();
  let calls = 0;
  const failure = { version: 1, error: { code: "NOT_FOUND", message: "Code not found.", details: null } };
  const invocation = context(["pull"], { all: true, out: join(root, "partial") }, "json", () =>
    ++calls === 1
      ? Response.json({ version: 1, items: [{ version: 1, config, files: { "code.ts": "saved source" } }], nextCursor: config.codeId })
      : Response.json(failure, { status: 404 }),
  );
  expect(await code.run(invocation.ctx)).toBe(1);
  expect(invocation.printed).toEqual([failure]);
  expect(await readFile(join(root, "partial", "example", "box_1234", "code.ts"), "utf8")).toBe("saved source");
});

test("explicit status checkout roots take precedence over an enclosing project", async () => {
  const { directory } = await project();
  const nestedRoot = join(directory, "instance-code");
  const nestedConfig = { ...config, codeId: "c_5678", owner: { kind: "person" as const, userId: uuid } };
  await writeCodeProject(nestedRoot, nestedConfig, { "code.ts": "nested source" });
  expect((await listCodeProjects(nestedRoot)).map((project) => project.config.codeId)).toEqual(["c_5678"]);
});
test.each(["json", "jsonl"] as const)("empty pull --all preserves host %s formatting", async (output) => {
  const { root } = await project();
  const invocation = context(["pull"], { all: true, out: join(root, "empty") }, output, () =>
    Response.json({ version: 1, items: [], nextCursor: null }),
  );
  expect(await code.run(invocation.ctx)).toBe(0);
  expect(await listCodeProjects(join(root, "empty"))).toEqual([]);
  expect(invocation.printed.join("")).toBe(
    output === "json" ? '{\n  "version": 1,\n  "items": [],\n  "nextCursor": null\n}\n' : '{"version":1,"items":[],"nextCursor":null}\n',
  );
});

test("status defaults to the current project or ./code without scanning unrelated folders", async () => {
  const { root } = await project();
  const directory = await writeCodeProject(join(root, "code"), config, { "code.ts": source });
  await symlink(join(root, "example"), join(root, "unrelated-link"));
  const script = join(root, "status-default.ts");
  await writeFile(
    script,
    `import { listCodeProjects } from ${JSON.stringify(import.meta.dir + "/code-files.ts")}; console.log(JSON.stringify((await listCodeProjects()).map(project => project.config.codeId)));`,
  );
  for (const cwd of [root, directory]) {
    const child = Bun.spawn([process.execPath, script], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual([config.codeId]);
  }
});

test("resource pulls use Code IDs for unsafe IDs and colliding resource types without overwrites", async () => {
  const { root, directory } = await project();
  const second = { ...config, codeId: "c_5678", owner: { kind: "resource" as const, ref: { type: "example.folder", id: "box_1234" } } };
  expect(await writeCodeProject(root, second, { "code.ts": "second" })).toBe(join(root, "example", "@c_5678"));
  expect(await readFile(join(directory, "code.ts"), "utf8")).toBe(source);
  await expect(writeCodeProject(root, second, {})).rejects.toThrow();
  const unsafe = { ...config, codeId: "c_9012", owner: { kind: "resource" as const, ref: { type: "example.box", id: "a:b.c" } } };
  expect(await writeCodeProject(root, unsafe, {})).toBe(join(root, "example", "@c_9012"));
  expect((await listCodeProjects(root)).map((project) => project.config.codeId)).toEqual(["c_1234", "c_5678", "c_9012"]);
});
test("status discovers resource folders named build, test and sdk and returns empty roots", async () => {
  const { root, directory } = await project();
  const out = join(root, "all-names");
  for (const [index, name] of ["build", "test", "sdk"].entries()) {
    await writeCodeProject(
      out,
      { ...config, codeId: `c_000${index}`, owner: { kind: "resource", ref: { type: `${name}.item`, id: name } } },
      {},
    );
  }
  expect((await listCodeProjects(out)).map((project) => project.config.codeId)).toEqual(["c_0000", "c_0001", "c_0002"]);
  const empty = join(directory, "empty-checkout");
  await mkdir(empty);
  expect(await listCodeProjects(empty)).toEqual([]);
});
test("pretty pull JSON preserves Unicode line separators in source strings", async () => {
  const { root } = await project();
  const pulled = { version: 1, config, files: { "code.ts": "const text = 'a\u2028b\u2029c';" } };
  const invocation = context(["pull"], { all: true, out: join(root, "unicode") }, "json", () =>
    Response.json({ version: 1, items: [pulled], nextCursor: null }),
  );
  expect(await code.run(invocation.ctx)).toBe(0);
  expect(JSON.parse(invocation.printed.join(""))).toEqual({ version: 1, items: [pulled], nextCursor: null });
});
test("invalid operation IDs fail without schema diagnostics or network requests", async () => {
  const { directory } = await project();
  const invocation = context(["runs", directory], { run: "nope" });
  expect(await code.run(invocation.ctx)).toBe(1);
  expect(invocation.requests).toEqual([]);
  expect(invocation.printed).toEqual([
    {
      version: 1,
      error: { code: "code_cli_input", message: "Invalid Code command input. Check IDs, cursors and flags with --help.", details: null },
    },
  ]);
});

test("status with no current project and no default code folder returns an empty list", async () => {
  const { root } = await project();
  const empty = join(root, "no-project");
  await mkdir(empty);
  const script = join(root, "status-empty.ts");
  await writeFile(
    script,
    `import { listCodeProjects } from ${JSON.stringify(import.meta.dir + "/code-files.ts")}; console.log(JSON.stringify(await listCodeProjects()));`,
  );
  const child = Bun.spawn([process.execPath, script], { cwd: empty, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual([]);
});
