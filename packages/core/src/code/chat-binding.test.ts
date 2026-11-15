import { expect, mock, spyOn, test } from "bun:test";
import { CODE_BOUND_CHAT_ID } from "@k2b/cloud/code";
import { type CapabilityExecutionContext, UserSchema } from "@k2b/cloud/contracts";
import type { SQL } from "bun";
import type { CodeContext } from "./access";
import { codeAuthoringServices } from "./authoring";
import { CodeChatBindingSchema, requireCodeChatOwner, resolveCodeChatDestination } from "./chat-binding";
import type { Code } from "./contracts";
import { describeCodeNotices } from "./read-model/notices";
import * as store from "./store";

const id = "c4330000-0000-4000-8000-000000000001";
const user = UserSchema.parse({
  id,
  uid: "owner",
  provider: "local",
  profile: "user",
  roles: ["user"],
  displayName: "Owner",
  givenname: "Code",
  sn: "Owner",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});
const context: CodeContext = {
  authority: { actor: { kind: "user", user }, accessSubject: { type: "user", userId: id }, credentialKind: "session", scopes: [] },
};

test("only personal ownership permits changing the chat, independently of editor or administrator grants", () => {
  expect(requireCodeChatOwner({ owner_kind: "person", owner_user_id: id }, context)).toEqual(user);
  for (const owner_kind of ["person", "resource", "app"] as const) {
    expect(() => requireCodeChatOwner({ owner_kind, owner_user_id: "c4330000-0000-4000-8000-000000000002" }, context)).toThrow(
      "Only the personal Code owner",
    );
  }
});

test("hidden and deleted bindings carry no chat identity or title", () => {
  for (const chat of [{ state: "hidden" }, { state: "unavailable", reason: "deleted" }]) {
    const base = { codeId: "c_1234", revision: 1, canChange: false, chat };
    expect(CodeChatBindingSchema.parse(base)).toEqual(base);
    for (const field of [{ title: "Private chat" }, { id: "cHt234" }])
      expect(CodeChatBindingSchema.safeParse({ ...base, chat: { ...chat, ...field } }).success).toBe(false);
  }
});

test("unavailable bindings require a reason and archived bindings may identify the restorable chat", () => {
  const base = { codeId: "c_1234", revision: 1, canChange: true };
  const archived = { state: "unavailable", reason: "archived", id: "cHt234", title: "Morning report" };
  expect(CodeChatBindingSchema.parse({ ...base, chat: archived }).chat).toEqual(archived);
  expect(CodeChatBindingSchema.parse({ ...base, chat: { state: "unavailable", reason: "archived" } }).chat).toEqual({
    state: "unavailable",
    reason: "archived",
  });
  expect(CodeChatBindingSchema.safeParse({ ...base, chat: { state: "unavailable" } }).success).toBe(false);
});

test.each(["de", "en"])("a missing chat has a visible recovery notice in %s", (locale) => {
  expect(describeCodeNotices([{ code: "chat_missing" }], locale)).toEqual([
    {
      severity: "block",
      text: locale === "de" ? "Diese Automation braucht einen Chat." : "This automation needs a chat.",
      consequence:
        locale === "de"
          ? "Der Besitzer kann einen anderen Chat wählen oder den archivierten Chat wiederherstellen."
          : "The owner can choose another chat or restore the archived chat.",
    },
  ]);
});

test("init passes only the authenticated chat origin into Code creation, keeping it out of the project", async () => {
  const created: Code = {
    id: "c_1234",
    title: "Morning report",
    owner: { kind: "person", userId: id },
    state: "draft",
    serviceAccountId: null,
    serviceAccountHandle: null,
    activeVersionId: null,
    pauseReason: null,
    pauseRows: [],
    pausePolicyRevision: null,
    createdBy: id,
    createdAt: "2030-01-07T08:00:00.000Z",
  };
  const create = spyOn(store, "createCode").mockResolvedValue(created);
  const conversationId = "c4330000-0000-4000-8000-000000000003";
  try {
    const initialized = await codeAuthoringServices.init(
      { title: created.title },
      { ...context, submissionOrigin: { kind: "ai_chat", conversationId, cardAnchor: "tool-init", automaticAfterReview: false } },
    );
    expect(create.mock.calls[0]?.[0]).toEqual({ title: created.title, owner: created.owner, chatConversationId: conversationId });
    expect(JSON.stringify(initialized)).not.toContain(conversationId);
    await codeAuthoringServices.init({ title: created.title }, context);
    expect(create.mock.calls[1]?.[0]).toEqual({ title: created.title, owner: created.owner });
  } finally {
    create.mockRestore();
  }
});

const runContext = (): CapabilityExecutionContext => ({
  authority: context.authority,
  actor: {
    kind: "user",
    user,
    delegation: {
      kind: "invocation",
      credentialKind: "mandate",
      callingAppId: "core",
      invocationId: "binding-test",
      workloadType: "code.version",
      workloadId: id,
      workloadRun: id,
    },
  },
  accessSubject: { type: "user", userId: id },
  user,
  origin: "http",
  requestId: "binding-test",
  signal: new AbortController().signal,
  target: { type: "core.ai.chat", id: CODE_BOUND_CHAT_ID },
});
// SQL's callable generic is supplied by a finite queue; no database connection is opened.
function bindingDb(rows: unknown[][]) {
  const pending = [...rows];
  const db = mock(async () => {
    const next = pending.shift();
    if (!next) throw new Error("Unexpected binding SQL statement");
    return next;
  });
  return { db: db as unknown as SQL, calls: db.mock.calls };
}
const boundRow = { id: "c_fixture", owner_kind: "person", owner_user_id: id, chat_conversation_id: id, chat_binding_revision: 7 };

test("literal destinations pass through without reading a binding", async () => {
  const fixture = bindingDb([]);
  expect(await resolveCodeChatDestination({ ...runContext(), target: { type: "core.ai.chat", id: "Literal433" } }, fixture.db)).toEqual({
    ok: true,
    data: { chatId: "Literal433", binding: null },
  });
  expect(fixture.calls).toHaveLength(0);
});

test.each(["session", "foreign-subject", "foreign-app"])("the bound destination refuses %s authority before reading", async (kind) => {
  const ctx = runContext();
  if (kind === "session") ctx.actor = { kind: "user", user };
  if (kind === "foreign-subject") ctx.accessSubject = { type: "user", userId: "other" };
  if (kind === "foreign-app" && ctx.actor.delegation) ctx.actor.delegation.callingAppId = "other";
  const fixture = bindingDb([]);
  expect(await resolveCodeChatDestination(ctx, fixture.db)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  expect(fixture.calls).toHaveLength(0);
});

test("the bound destination requires a current run and unchanged owner", async () => {
  for (const rows of [[[]], [[{ id: "c_fixture" }], [{ ...boundRow, owner_user_id: "other" }], [{ available: false }]]]) {
    expect(await resolveCodeChatDestination(runContext(), bindingDb(rows).db)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  }
});

test("each bound call reads the current short ID and binding revision", async () => {
  const fixture = bindingDb([
    [{ id: "c_fixture" }],
    [boundRow],
    [{ available: true }],
    [{ short_id: "Current433", title: "Private", project_id: null, archived_at: null }],
  ]);
  expect(await resolveCodeChatDestination(runContext(), fixture.db)).toEqual({
    ok: true,
    data: { chatId: "Current433", binding: { codeId: "c_fixture", revision: 7 } },
  });
});

test.each(["en", "de"])("unbound, archived, deleted and absent-schema destinations return recoverable conflicts in %s", async (locale) => {
  const prefix = [[{ id: "c_fixture" }]];
  for (const rows of [
    [...prefix, [{ ...boundRow, chat_conversation_id: null }]],
    [...prefix, [boundRow], [{ available: true }], [{ short_id: "Archived433", archived_at: new Date("2030-01-07T08:00:00.000Z") }]],
    [...prefix, [boundRow], [{ available: true }], []],
    [...prefix, [boundRow], [{ available: false }]],
  ]) {
    const unbound = rows.length === 2;
    expect(await resolveCodeChatDestination({ ...runContext(), locale }, bindingDb(rows).db)).toEqual({
      ok: false,
      error: {
        code: unbound ? "chat_unbound" : "chat_unavailable",
        status: 409,
        message: unbound
          ? locale === "de"
            ? "Wähle vor dem Senden einen Chat für diesen Code."
            : "Choose a chat for this Code before sending."
          : locale === "de"
            ? "Der gebundene Chat ist nicht verfügbar. Stelle ihn wieder her oder wähle einen anderen Chat."
            : "The bound chat is unavailable. Restore it or choose another chat.",
      },
    });
  }
});
