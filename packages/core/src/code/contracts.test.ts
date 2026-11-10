import { describe, expect, spyOn, test } from "bun:test";
import * as provider from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  type CapabilityExecutionContext,
  CloudResourceReaderViewSchema,
  CodeCheckedVersionManifestSchema,
  type User,
} from "@k2b/cloud/contracts";
import { z } from "zod";
import { aiCapabilities } from "../capabilities";
import { CodeOwnerUnavailableError, codePerson, readCodeOwner } from "./access";
import {
  CodeCallRefusalKindSchema,
  type CodeEventDeliverySchema,
  CodeOwnerSchema,
  type CodeRefusedCall,
  type CodeRun,
  CodeRunCursorSchema,
  CodeSourceFilesSchema,
  codeQueryContracts,
} from "./contracts";
import { runCodeQuery } from "./queries";
import { codeSourceHash, codeTextChunk } from "./store";
import { CodeVersionError } from "./versions";

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "code-test",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Code",
  sn: "Test",
  displayName: "Code Test",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const authority = {
  actor: { kind: "user" as const, user },
  accessSubject: { type: "user" as const, userId: user.id },
  credentialKind: "session" as const,
  scopes: [],
};
const context: CapabilityExecutionContext = {
  authority,
  actor: authority.actor,
  accessSubject: authority.accessSubject,
  user,
  locale: "de",
  requestId: "code-contract",
  target: { type: "core.code", id: "c_8hw2" },
  origin: "http",
  signal: new AbortController().signal,
};

describe("Core Code data contracts", () => {
  test("refusal kinds preserve policy and approval as separate public values", () => {
    expect(CodeCallRefusalKindSchema.options).toEqual(["target_refused", "policy", "approval", "app_not_allowed", "bridge"]);
  });
  test("exports permission-aware data and policy capabilities", () => {
    const manifest = compileCapabilityManifest("core", aiCapabilities);
    expect(manifest.actions.find((action) => action.localId === "code.secret.set")?.idempotency).toBe("none");
    expect(
      manifest.queries
        .filter((query) => query.localId.startsWith("code."))
        .map((query) => query.localId)
        .sort(),
    ).toEqual([
      "code.attention",
      "code.attention.list",
      "code.automation.list",
      "code.event.catchup.read",
      "code.list",
      "code.policy.effective",
      "code.policy.preview",
      "code.policy.read",
      "code.read",
      "code.run.count",
      "code.run.list",
      "code.run.read",
      "code.secret.list",
      "code.summary",
      "code.version.diff",
      "code.version.diff.read",
      "code.version.list",
      "code.version.origin",
      "code.version.read",
    ]);
    expect(
      manifest.actions.filter((action) => action.localId.startsWith("code.")).map((action) => ({ id: action.localId, code: action.code })),
    ).toEqual(
      [
        "code.event.catchup",
        "code.event.catchup.cancel",
        "code.event.catchup.resume",
        "code.event.redeliver",
        "code.pause",
        "code.policy.update",
        "code.resume",
        "code.run",
        "code.secret.delete",
        "code.secret.set",
        "code.version.approve",
        "code.version.reject",
        "code.version.submit",
      ].map((id) => ({ id, code: false })),
    );
  });
  test("checked event registrations require exact metadata and a matching stable entrypoint", () => {
    const event = { type: "fixture.changed", version: 1, place: { type: "fixture.collection", id: "one" } };
    const entry = { kind: "event", entrypoint: "event:fixture.changed@1", event, cron: null, file: "code.ts", line: 1 };
    const manifest = {
      version: 1,
      entry: "code.ts",
      entrypoints: [entry],
      permissions: [],
      policyRows: ["read"],
      ai: false,
      hashes: { source: "a".repeat(64), sdk: "b".repeat(64), bundle: "c".repeat(64) },
    };
    expect(CodeCheckedVersionManifestSchema.safeParse(manifest).success).toBe(true);
    for (const invalid of [
      { ...entry, event: undefined },
      { ...entry, entrypoint: "event:fixture.changed@2" },
      { ...entry, cron: "* * * * *" },
      { ...entry, kind: "manual" },
      { ...entry, event: { ...event, place: undefined } },
    ])
      expect(CodeCheckedVersionManifestSchema.safeParse({ ...manifest, entrypoints: [invalid] }).success).toBe(false);
  });
  test("owner union has exactly one opaque identity; source paths cannot escape the source tree", () => {
    expect(CodeOwnerSchema.parse({ kind: "resource", ref: { type: "example.mailbox", id: "m_1234" } })).toEqual({
      kind: "resource",
      ref: { type: "example.mailbox", id: "m_1234" },
    });
    expect(CodeOwnerSchema.safeParse({ kind: "person", userId: user.id, appId: "example" }).success).toBe(false);
    for (const path of ["../code.ts", "a/../code.ts", "/code.ts", "a\\code.ts", "a//b.ts", "./code.ts"])
      expect(CodeSourceFilesSchema.safeParse({ [path]: "x" }).success).toBe(false);
    expect(CodeSourceFilesSchema.safeParse({ "src/code.ts": "ä😀" }).success).toBe(true);
  });
  test("source hash sorts exact path/content pairs; different files and content change the digest", () => {
    expect(codeSourceHash({ "b.ts": "two", "a.ts": "one" })).toBe(codeSourceHash({ "a.ts": "one", "b.ts": "two" }));
    expect(codeSourceHash({ "a.ts": "one" })).not.toBe(codeSourceHash({ "b.ts": "one" }));
    expect(codeSourceHash({ "a.ts": "one" })).not.toBe(codeSourceHash({ "a.ts": "one\n" }));
  });
  test("chunks and call pages leave room for metadata within the capability response budget", () => {
    const input = codeQueryContracts.versionRead.input.parse({ codeId: "c_8hw2", versionId: "11111111-1111-4111-8111-111111111111" });
    expect(input.length).toBe(16_384);
    // A JSON control character expands to six bytes. This bound is independent of UTF-8 content.
    expect(Buffer.byteLength(JSON.stringify({ text: "\u0001".repeat(input.length) }))).toBeLessThan(CAPABILITY_MAX_RESULT_BYTES / 2);
    expect(codeQueryContracts.versionRead.input.safeParse({ ...input, length: 16_385 }).success).toBe(false);
    expect(codeQueryContracts.list.input.safeParse({ limit: 51 }).success).toBe(false);
  });
  test("manual run requires request authority and a write credential at the capability boundary", async () => {
    const input = { entrypoint: "weekly", input: null };
    const action = aiCapabilities.actions["code.run"];
    expect(await action.run(input, { ...context, idempotencyKey: "one", authority: undefined })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(
      await action.run(input, {
        ...context,
        idempotencyKey: "one",
        authority: { ...authority, credentialKind: "oauth", scopes: ["core:read"] },
      }),
    ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await action.run(input, context)).toMatchObject({ ok: false, error: { code: "BAD_INPUT" } });
  });
  test("missing authority and scope-limited credentials cannot fall back to the context's user", async () => {
    const result = await aiCapabilities.queries["code.read"].run({ codeId: "c_8hw2" }, { ...context, authority: undefined });
    expect(result.ok).toBe(false);
    expect(() => codePerson({ authority: { ...authority, credentialKind: "oauth", scopes: ["mail:read"] } })).toThrow("Credential");
    expect(() => codePerson({ authority: { ...authority, credentialKind: "oauth", scopes: ["core:read"] } }, true)).toThrow("Credential");
    expect(codePerson({ authority: { ...authority, credentialKind: "oauth", scopes: ["core:read"] } }).id).toBe(user.id);
  });
  test("catch-up progress requires editor credentials before reading operation state", async () => {
    const query = aiCapabilities.queries["code.event.catchup.read"];
    const input = { operationId: "11111111-1111-4111-8111-111111111111" };
    expect(await query.run(input, { ...context, authority: undefined })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(
      await query.run(input, { ...context, authority: { ...authority, credentialKind: "oauth", scopes: ["core:read"] } }),
    ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
});

test("secret values cannot enter through Assistant, MCP or app capability tools", async () => {
  for (const origin of ["assistant", "mcp", "app"] as const) {
    const result = await aiCapabilities.actions["code.secret.set"].run(
      { name: "API", binding_revision: null, value: "test-only-private-credential" },
      { ...context, origin },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(JSON.stringify(result)).not.toContain("test-only-private-credential");
  }
});

test("secret capability declarations compile with private writes and exact delete reviews", () => {
  const manifest = compileCapabilityManifest("core", {
    protocolVersion: 2,
    queries: { "code.secret.list": aiCapabilities.queries["code.secret.list"] },
    types: { code: aiCapabilities.types.code },
    actions: {
      "code.secret.set": aiCapabilities.actions["code.secret.set"],
      "code.secret.delete": aiCapabilities.actions["code.secret.delete"],
    },
  });
  expect(manifest.actions.find((action) => action.localId === "code.secret.set")).toMatchObject({
    idempotency: "none",
    approval: "none",
    unattended: false,
  });
  expect(manifest.policies?.["code.secret.delete"]).toEqual({ ask: "deletes" });
});

test("owner presentation and default editorship use the live authorized canonical reader", async () => {
  const manifest = compileCapabilityManifest("example", {
    protocolVersion: 2,
    types: { mailbox: { title: "Mailbox", description: "A mailbox.", reader: "mailbox.read" } },
    queries: {
      "mailbox.read": {
        title: "Read mailbox",
        description: "Read one mailbox.",
        openWorld: false,
        input: z.object({ id: z.string().describe("Mailbox ID.") }).strict(),
        data: z.object({ view: CloudResourceReaderViewSchema }).strict(),
        run: () => ({ ok: true, data: { data: { view: { title: "Mailbox", permission: "read" } } } }),
      },
    },
  });
  const catalog = spyOn(provider, "getCapabilityCatalogApp").mockResolvedValue({
    ok: true,
    data: {
      appId: "example",
      appName: "Example",
      appIcon: "ti ti-mail",
      appDescription: "Example owner",
      manifest,
    },
  });
  const invoke = spyOn(provider, "invokeCapabilityWithDataSchema").mockResolvedValue({
    ok: true,
    data: { data: { view: { title: "Live title", permission: "admin" } } },
  });
  try {
    const owner = { kind: "resource" as const, ref: { type: "example.mailbox", id: "m_1234" } };
    expect(await readCodeOwner(owner, { authority, locale: "de", signal: context.signal })).toEqual({ title: "Live title", admin: true });
    expect(invoke).toHaveBeenCalledWith(
      { appId: "example", capabilityId: "mailbox.read", kind: "query", input: { id: "m_1234" } },
      expect.anything(),
      { authority, locale: "de", signal: context.signal },
    );
    invoke.mockResolvedValue({ ok: true, data: { data: { view: { title: "Renamed", permission: "read" } } } });
    expect(await readCodeOwner(owner, { authority })).toEqual({ title: "Renamed", admin: false });
    invoke.mockResolvedValue({ ok: false, error: { code: "NOT_FOUND", message: "Not found", status: 404 } });
    expect(await readCodeOwner(owner, { authority })).toBeNull();
  } finally {
    invoke.mockRestore();
    catalog.mockRestore();
  }
});

test("text chunks make progress without splitting surrogate pairs and reject split offsets", () => {
  expect(codeTextChunk("a😀b", 0, 2)).toEqual({ text: "a", nextOffset: 1 });
  expect(codeTextChunk("a😀b", 1, 1)).toEqual({ text: "😀", nextOffset: 3 });
  expect(codeTextChunk("a😀b", 3, 10)).toEqual({ text: "b", nextOffset: null });
  expect(() => codeTextChunk("a😀b", 2, 10)).toThrow("surrogate pair");
  expect(codeTextChunk("done", 10, 10)).toEqual({ text: "", nextOffset: null });
});

test("run content chunks and precise keyset cursors are validated", () => {
  const input = { codeId: "c_8hw2", runId: user.id, content: { kind: "result", ordinal: 1 } };
  expect(codeQueryContracts.runRead.input.parse(input)).toMatchObject({ cursor: 0, offset: 0, length: 16384 });
  expect(codeQueryContracts.runRead.input.safeParse({ ...input, length: 16385 }).success).toBe(false);
  expect(codeQueryContracts.runRead.input.safeParse({ ...input, content: { kind: "result", ordinal: 0 } }).success).toBe(false);
  expect(CodeRunCursorSchema.safeParse(`2026-10-31T12:00:00.123456Z|${user.id}`).success).toBe(true);
  expect(CodeRunCursorSchema.safeParse(`2026-13-31T12:00:00.123456Z|${user.id}`).success).toBe(false);
});

test("owner-provider failures return a recoverable Query error", async () => {
  const result = await runCodeQuery(context, async () => {
    throw new CodeOwnerUnavailableError("offline");
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("INTERNAL");
    expect(result.error.message).toContain("Try again");
  }
});

test("large base conflicts retain their stable refusal and complete-diff reader", async () => {
  const diffRead = { query: "core.code.version.diff.read", input: { codeId: "c_test" } };
  const result = await runCodeQuery(context, async () => {
    throw new CodeVersionError("code_version_conflict", "Newer version", {
      latestVersionId: user.id,
      files: "x".repeat(CAPABILITY_MAX_RESULT_BYTES),
      diffRead,
    });
  });
  expect(result).toMatchObject({ ok: false, error: { code: "code_version_conflict", details: { latestVersionId: user.id, diffRead } } });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(CAPABILITY_MAX_RESULT_BYTES);
});

test("Code data contracts bundle for browsers without loading the server API", async () => {
  const result = await Bun.build({ entrypoints: [new URL("./contracts.ts", import.meta.url).pathname], target: "browser" });
  expect(result.logs).toEqual([]);
  expect(result.success).toBe(true);
});

test("run lists retain legacy replies and keep event delivery metadata bounded and payload-free", () => {
  const legacy = { items: [], nextCursor: null };
  const delivery = {
    id: user.id,
    eventId: user.id,
    eventType: "fixture.changed",
    state: "failed",
    code: "handler_failed",
    attempts: 8,
    createdAt: "2026-11-03T12:00:00.000Z",
  } satisfies z.input<typeof CodeEventDeliverySchema>;
  expect(codeQueryContracts.runList.data.parse(legacy)).toEqual(legacy);
  const extended = { ...legacy, eventDeliveries: [delivery] };
  expect(codeQueryContracts.runList.data.parse(extended)).toEqual(extended);
  expect(
    codeQueryContracts.runList.data.safeParse({ ...legacy, eventDeliveries: [{ ...delivery, data: { private: "payload" } }] }).success,
  ).toBe(false);
  expect(
    codeQueryContracts.runList.data.safeParse({ ...legacy, eventDeliveries: Array.from({ length: 21 }, () => delivery) }).success,
  ).toBe(false);
});

test("Code CLI run payload keeps version 1 and the additive refused-call summary", async () => {
  const { codeAuthoringContracts } = await import("./authoring-contracts");
  const run = {
    id: user.id,
    codeId: "c_test",
    versionId: user.id,
    trigger: "manual",
    entrypoint: "weekly",
    state: "failed",
    outcome: "failed",
    firstRefusedCallOrdinal: 2,
    createdAt: "2026-11-03T12:00:00.000Z",
    startedAt: null,
    endedAt: null,
    rerunOf: null,
    rerunByName: null,
  } satisfies CodeRun;
  const summary = {
    ordinal: 2,
    kind: "action",
    capability: "example.item.update",
    target: { type: "example.item", id: "runtime-id" },
  } satisfies CodeRefusedCall;
  const contents = {
    input: null,
    output: null,
    inputChunked: false,
    outputChunked: false,
    content: null,
    firstRefusedCall: summary,
    calls: [],
    nextCursor: null,
  };
  expect(codeAuthoringContracts.runRead.data.parse({ version: 1, run, contents })).toEqual({ version: 1, run, contents });
  expect(codeAuthoringContracts.runRead.data.parse({ version: 1, run, contents: null })).toEqual({ version: 1, run, contents: null });
});

test("Code list adapters expose their domain cursor through the shared page envelope", async () => {
  for (const nextCursor of ["c_next", null]) {
    const result = await runCodeQuery(context, async () => ({ items: [], nextCursor }));
    expect(result).toEqual({
      ok: true,
      data: { data: { items: [], nextCursor }, page: nextCursor === null ? { hasMore: false } : { hasMore: true, nextCursor } },
    });
  }
  expect(await runCodeQuery(context, async () => ({ title: "Non-paginated" }))).toEqual({
    ok: true,
    data: { data: { title: "Non-paginated" } },
  });
});
