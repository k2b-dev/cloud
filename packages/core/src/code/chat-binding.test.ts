import { expect, spyOn, test } from "bun:test";
import { UserSchema } from "@k2b/cloud/contracts";
import type { CodeContext } from "./access";
import { codeAuthoringServices } from "./authoring";
import { CodeChatBindingSchema, requireCodeChatOwner } from "./chat-binding";
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

test("hidden and unavailable bindings carry no chat identity or title", () => {
  for (const state of ["hidden", "unavailable"] as const) {
    const base = { codeId: "c_1234", revision: 1, canChange: false, chat: { state } };
    expect(CodeChatBindingSchema.parse(base)).toEqual(base);
    expect(CodeChatBindingSchema.safeParse({ ...base, chat: { state, title: "Private chat" } }).success).toBe(false);
  }
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
