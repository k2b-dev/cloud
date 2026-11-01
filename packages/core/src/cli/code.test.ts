import { afterAll, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, readFile, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudCliContext, CloudCliFlags, CloudCliOutputMode } from "@k2b/cloud/cli";
import { codeTestFailure } from "@k2b/cloud/code";
import type { CodeAuthoringData, CodeProject } from "../code/authoring-contracts";
import code from "./code";
import { codeProjectFolder, loadCodeProject, readCodeFiles, writeCodeProject } from "./code-files";

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
  expect(() => codeProjectFolder({ ...config, owner: { kind: "resource", ref: { type: "example.box", id: "../escape" } } })).toThrow();
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
    expect(await code.run(run.ctx)).not.toBe(1);
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
  const run = context([command, directory], { yes: true, "activation-id": uuid });
  expect(await code.run(run.ctx)).toBe(1);
  expect(run.requests).toEqual([]);
  expect(run.printed).toEqual([
    { version: 1, error: { code: "code_cli_input", message: "Keine gespeicherte Version. Führe zuerst push aus.", details: null } },
  ]);
});
