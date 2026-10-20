import { describe, expect, test } from "bun:test";
import {
  actorCommandInputSchema,
  addConversationLocalTagsSchema,
  createConversationCommentSchema,
  draftContentInputSchema,
  draftSeedOriginSchema,
  mailSearchFolderIdSchema,
  mailSearchExpressionSchema,
  internalMailSearchStateSchema,
  mailSearchLocalTagIdSchema,
  mergeConversationsInputSchema,
  ResourceShortIdSchema,
} from "./contracts";

const shortId = "aB3dE6";
const uuid = "11111111-1111-4111-8111-111111111111";

describe("Mail public resource IDs", () => {
  test("accepts only stable six-character IDs", () => {
    expect(ResourceShortIdSchema.parse(shortId)).toBe(shortId);
    for (const value of [uuid, "short", "toolong", "abc-12"]) {
      expect(ResourceShortIdSchema.safeParse(value).success).toBe(false);
    }
  });

  test("uses short IDs in search and conversation mutation relations", () => {
    expect(mailSearchFolderIdSchema.safeParse({ type: "folder_id", folderId: shortId }).success).toBe(true);
    expect(mailSearchFolderIdSchema.safeParse({ type: "folder_id", folderId: uuid }).success).toBe(false);
    expect(mailSearchLocalTagIdSchema.safeParse({ type: "local_tag_id", tagId: shortId }).success).toBe(true);
    expect(mailSearchLocalTagIdSchema.safeParse({ type: "local_tag_id", tagId: uuid }).success).toBe(false);
    expect(
      mergeConversationsInputSchema.safeParse({
        sourceConversationId: shortId,
        expectedTargetRevision: 1,
        expectedSourceRevision: 1,
        confirm: true,
      }).success,
    ).toBe(true);
    expect(addConversationLocalTagsSchema.safeParse({ conversationIds: [shortId], tagIds: [uuid] }).success).toBe(false);
  });

  test("uses short IDs throughout compose and comment inputs", () => {
    expect(
      draftContentInputSchema.safeParse({
        senderIdentityId: shortId,
        conversationId: shortId,
        sourceMessageId: shortId,
      }).success,
    ).toBe(true);
    expect(draftContentInputSchema.safeParse({ senderIdentityId: uuid }).success).toBe(false);
    expect(createConversationCommentSchema.safeParse({ body: "Internal note", referencedMessageId: uuid }).success).toBe(false);
  });

  test("uses a public message and folder identity for provider mutations", () => {
    const input = {
      kind: "change_message_state",
      messageId: shortId,
      folderId: "Foldr1",
      change: { addFlags: ["seen"], removeFlags: [], addKeywords: [], removeKeywords: [] },
      idempotencyKey: "state-change",
    };
    expect(actorCommandInputSchema.safeParse(input).success).toBe(true);
    expect(actorCommandInputSchema.safeParse({ ...input, messageId: uuid }).success).toBe(false);
    expect(actorCommandInputSchema.safeParse({ ...input, remoteMessageRefId: uuid }).success).toBe(false);
  });

  test("uses a mailbox-scoped public message identity for draft derivation", () => {
    const origin = {
      kind: "derive",
      messageId: shortId,
      input: { kind: "edit_as_new", senderIdentityId: "Send01", includeAttachments: true },
    };
    expect(draftSeedOriginSchema.safeParse(origin).success).toBe(true);
    expect(draftSeedOriginSchema.safeParse({ ...origin, messageId: uuid }).success).toBe(false);
  });
});

describe("Mail placement flag conditions", () => {
  for (const type of ["unread", "flagged"] as const)
    test(`${type} preserves explicit public scope and rejects internal IDs at transport`, () => {
      for (const folderId of [undefined, null, shortId]) {
        const expression = folderId === undefined ? { type } : { type, folderId };
        expect(mailSearchExpressionSchema.parse(expression)).toEqual(expression);
      }
      expect(mailSearchExpressionSchema.safeParse({ type, folderId: uuid }).success).toBe(false);
      expect(mailSearchExpressionSchema.safeParse({ type, folderId: "" }).success).toBe(false);
      expect(internalMailSearchStateSchema.parse({ expression: { type, folderId: uuid } }).expression).toEqual({ type, folderId: uuid });
      expect(internalMailSearchStateSchema.safeParse({ expression: { type, folderId: shortId } }).success).toBe(false);
    });
});
