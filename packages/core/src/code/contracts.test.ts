import { describe, expect, spyOn, test } from "bun:test";
import * as provider from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  type CapabilityExecutionContext,
  CloudResourceReaderViewSchema,
  type User,
} from "@k2b/cloud/contracts";
import { z } from "zod";
import { aiCapabilities } from "../capabilities";
import { CodeOwnerUnavailableError, codePerson, readCodeOwner } from "./access";
import { CodeOwnerSchema, CodeRunCursorSchema, CodeSourceFilesSchema, codeQueryContracts } from "./contracts";
import { runCodeQuery } from "./queries";
import { codeSourceHash, codeTextChunk } from "./store";

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
  origin: "http",
  signal: new AbortController().signal,
};

describe("Core Code data contracts", () => {
  test("exports permission-aware data and policy capabilities", () => {
    const manifest = compileCapabilityManifest("core", aiCapabilities);
    expect(
      manifest.queries
        .filter((query) => query.localId.startsWith("code."))
        .map((query) => query.localId)
        .sort(),
    ).toEqual([
      "code.list",
      "code.policy.effective",
      "code.policy.preview",
      "code.policy.read",
      "code.read",
      "code.run.list",
      "code.run.read",
      "code.version.diff",
      "code.version.list",
      "code.version.read",
    ]);
    expect(
      manifest.actions.filter((action) => action.localId.startsWith("code.")).map((action) => ({ id: action.localId, code: action.code })),
    ).toEqual(
      ["code.version.submit", "code.version.approve", "code.version.reject", "code.pause", "code.resume", "code.policy.update"].map(
        (id) => ({ id, code: false }),
      ),
    );
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
  test("missing authority and scope-limited credentials cannot fall back to the context's user", async () => {
    const result = await aiCapabilities.queries["code.read"].run({ codeId: "c_8hw2" }, { ...context, authority: undefined });
    expect(result.ok).toBe(false);
    expect(() => codePerson({ authority: { ...authority, credentialKind: "oauth", scopes: ["mail:read"] } })).toThrow("Credential");
    expect(() => codePerson({ authority: { ...authority, credentialKind: "oauth", scopes: ["core:read"] } }, true)).toThrow("Credential");
    expect(codePerson({ authority: { ...authority, credentialKind: "oauth", scopes: ["core:read"] } }).id).toBe(user.id);
  });
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
