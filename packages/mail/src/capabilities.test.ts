import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { compileCapabilityManifest } from "@valentinkolb/cloud/capabilities/testing";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  type CapabilityActionDefinition,
  CapabilityActionReviewSchema,
  type CapabilityExecutionContext,
  capabilityResultSchema,
} from "@valentinkolb/cloud/contracts";
import { mailCapabilities } from "./capabilities";
import {
  ActivityListDataSchema,
  AttachmentContentReadDataSchema,
  AttachmentReadDataSchema,
  CommentListDataSchema,
  ConversationFocusListDataSchema,
  ConversationGetDataSchema,
  ConversationListDataSchema,
  ConversationMarkInputSchema,
  ConversationMoveInputSchema,
  ConversationRelatedDataSchema,
  ConversationSearchDataSchema,
  DraftCreateInputSchema,
  DraftListDataSchema,
  DraftSendInputSchema,
  DraftUpdateInputSchema,
  FolderListDataSchema,
  MessageDataSchema,
  MessageListDataSchema,
  SubscriptionListDataSchema,
  SubscriptionUnsubscribeInputSchema,
} from "./capability-contracts";
import {
  attachmentExtraction,
  collaboration,
  commands,
  composeSafety,
  conversationContext,
  conversationSummaries,
  drafts,
  draftUploads,
  focus,
  listSubscriptions,
  localTags,
  mailboxAccess,
  mailboxes,
  messages,
  publicResources,
  reminders,
  resourceParents,
  scheduledSends,
  search,
  triage,
} from "./service";

const mailboxId = "MbA123";
const conversationId = "CvB234";
const folderId = "FdC345";
const senderIdentityId = "SiD456";
const deliveryId = "DlE567";
const tagId = "TgF678";
const folderAId = "FaA111";
const folderBId = "FbB222";
const folderCId = "FcC333";
const internalMailboxId = "553cd2c2-6dd8-47c7-bd2d-f731e78bc7ef";
const internalConversationId = "34e29d53-8e6a-4a4d-bd83-4ad8d69957c8";
const internalRelatedConversationId = "99999999-9999-4999-8999-999999999999";
const relatedConversationId = "Rel123";
const internalFolderId = "dc1fe87d-c60b-4f63-a83d-9db6320da31d";
const internalFolderAId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const internalFolderBId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const internalFolderCId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const internalCommentId = "11111111-1111-4111-8111-111111111111";
const internalDraftId = "22222222-2222-4222-8222-222222222222";
const internalDraftAttachmentId = "33333333-3333-4333-8333-333333333333";
const internalTagId = "44444444-4444-4444-8444-444444444444";
const internalReminderId = "45454545-4545-4545-8545-454545454545";
const internalMessageId = "55555555-5555-4555-8555-555555555555";
const internalAttachmentId = "88888888-8888-4888-8888-888888888888";
const missingResourceId = "66666666-6666-4666-8666-666666666666";
const technicalTargetId = "77777777-7777-4777-8777-777777777777";
const commentId = "CmK012";
const draftId = "DrG789";
const draftAttachmentId = "DaL123";
const reminderId = "RmN234";
const messageId = "MsH890";
const attachmentId = "AtJ901";
const userId = "dc1fe87d-c60b-4f63-a83d-9db6320da31d";
const publicIdsByTable = {
  mailboxes: new Map([[internalMailboxId, mailboxId]]),
  folders: new Map([
    [internalFolderId, folderId],
    [internalFolderAId, folderAId],
    [internalFolderBId, folderBId],
    [internalFolderCId, folderCId],
  ]),
  conversations: new Map([
    [internalConversationId, conversationId],
    [internalRelatedConversationId, relatedConversationId],
  ]),
  messages: new Map([
    [internalConversationId, messageId],
    [internalMessageId, messageId],
  ]),
  senderIdentities: new Map([[internalConversationId, senderIdentityId]]),
  deliveries: new Map([[internalConversationId, deliveryId]]),
  tags: new Map([
    [internalConversationId, tagId],
    [internalTagId, tagId],
  ]),
  comments: new Map([[internalCommentId, commentId]]),
  attachments: new Map([[internalAttachmentId, attachmentId]]),
  drafts: new Map([[internalDraftId, draftId]]),
  draftAttachments: new Map([[internalDraftAttachmentId, draftAttachmentId]]),
  reminders: new Map([[internalReminderId, reminderId]]),
} as const;
const internalIdsByTable = {
  mailboxes: new Map([[mailboxId, internalMailboxId]]),
  folders: new Map([[folderId, internalFolderId]]),
  conversations: new Map([[conversationId, internalConversationId]]),
  drafts: new Map([[draftId, internalDraftId]]),
  senderIdentities: new Map([[senderIdentityId, internalConversationId]]),
  deliveries: new Map([[deliveryId, internalConversationId]]),
  tags: new Map([[tagId, internalConversationId]]),
  comments: new Map([[commentId, internalCommentId]]),
  draftAttachments: new Map([[draftAttachmentId, internalDraftAttachmentId]]),
  attachments: new Map([[attachmentId, internalAttachmentId]]),
} as const;
const context = {
  actor: { kind: "user", user: { id: userId } },
  accessSubject: { type: "user", userId },
  user: { id: userId },
  signal: new AbortController().signal,
} as CapabilityExecutionContext;

const timestamp = "2026-08-20T10:00:00.000Z";
const draftFixture = {
  id: internalDraftId,
  mailboxId: internalMailboxId,
  conversationId: null,
  intent: "new",
  sourceMessageId: null,
  derivedFromMessageId: null,
  derivationKind: null,
  senderIdentityId: internalConversationId,
  to: [{ name: "Ada", address: "ada@example.test" }],
  cc: [],
  bcc: [],
  subject: "Release follow-up",
  body: "The release is ready.",
  format: "markdown",
  priority: "normal",
  requestDeliveryReceipt: false,
  requestReadReceipt: false,
  attachments: [
    {
      id: internalDraftAttachmentId,
      filename: "notes.pdf",
      contentType: "application/pdf",
      byteLength: 5,
      contentHash: "a".repeat(64),
      position: 0,
      createdAt: timestamp,
    },
  ],
  createdBy: { kind: "user", userId },
  lastEditedBy: { kind: "user", userId },
  lastEditedByDisplayName: "Ada",
  recoveryCopyCount: 0,
  revision: 2,
  state: "draft",
  deliveryClass: "normal",
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;
const collaborationFixture = {
  conversationId: internalConversationId,
  assignee: { id: userId, uid: "ada", displayName: "Ada Lovelace", avatarHash: null },
  workStatus: "done",
  snoozedUntil: timestamp,
  revision: 5,
} as const;
const reminderFixture = {
  id: internalReminderId,
  conversationId: internalConversationId,
  userId,
  dueAt: timestamp,
  state: "pending",
  revision: 2,
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;
const commentFixture = {
  id: internalCommentId,
  conversationId: internalConversationId,
  body: "Internal context",
  author: { kind: "user", id: userId, displayName: "Ada Lovelace", avatarHash: null },
  referencedMessageId: null,
  revision: 3,
  canEdit: true,
  canDelete: true,
  editedAt: null,
  deletedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;
const tagFixture = {
  id: internalTagId,
  mailboxId: internalMailboxId,
  name: "customer",
  color: "#336699",
  revision: 2,
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;

beforeEach(() => {
  spyOn(publicResources, "resolvePublicId").mockImplementation(
    async (table, id) => (internalIdsByTable as Record<string, Map<string, string>>)[table]?.get(id) ?? null,
  );
  spyOn(publicResources, "resolveMailboxPublicId").mockImplementation(
    async (table, _mailboxId, id) => (internalIdsByTable as Record<string, Map<string, string>>)[table]?.get(id) ?? null,
  );
  spyOn(publicResources, "resolveMailboxPublicIds").mockImplementation(async (table, _mailboxId, ids) => {
    const resolved = ids.map((id) => (internalIdsByTable as Record<string, Map<string, string>>)[table]?.get(id));
    return resolved.every((id): id is string => id !== undefined) ? resolved : null;
  });
  spyOn(publicResources, "publicIds").mockImplementation(
    async (table) => new Map((publicIdsByTable as Record<string, Map<string, string>>)[table] ?? []),
  );
});

afterEach(() => mock.restore());

describe("mail capabilities", () => {
  test("compiles into a registrable v1 manifest", () => {
    const manifest = compileCapabilityManifest("mail", mailCapabilities);
    expect(manifest.appId).toBe("mail");
    expect(mailCapabilities.types.conversation.icon).toBe("ti ti-mail");
    expect(manifest.queries).toHaveLength(Object.keys(mailCapabilities.queries).length);
    expect(manifest.actions).toHaveLength(Object.keys(mailCapabilities.actions).length);
    const mailboxReader = manifest.queries.find((query) => query.localId === "mailbox.read");
    expect(mailboxReader?.inputSchema).toHaveProperty("properties.id.description", expect.stringContaining("List mailboxes"));
    expect(mailCapabilities.queries["mailbox.list"].description).toContain("Normal entry for mailbox-scoped Mail work");
    expect(mailCapabilities.queries.search.description).toContain("direct cross-mailbox entry");
    expect(mailCapabilities.queries["conversation.search"].description).toContain("use search instead when no mailbox is known");
    expect(mailCapabilities.queries["conversation.read"].description).toContain("call message.read");
    expect(mailCapabilities.queries["message.read"].description).toContain("attachment.read-content");
    expect(mailCapabilities.queries["draft.send.review"].description).toContain("immediately before draft.send");
  });

  test("only exposes remembered approval for reversible internal mail changes", () => {
    const rememberable = (Object.entries(mailCapabilities.actions) as Array<[string, CapabilityActionDefinition]>)
      .filter(([, action]) => action.approval === "rememberable")
      .map(([localId]) => localId)
      .sort();
    expect(rememberable).toEqual([
      "conversation.assign",
      "conversation.comment.create",
      "conversation.comment.update",
      "conversation.mark",
      "conversation.reminder.cancel",
      "conversation.reminder.set",
      "conversation.snooze",
      "conversation.status.update",
      "conversation.tag.update",
      "draft.attachment.add",
      "draft.create",
      "draft.update",
      "mailbox.tag.create",
    ]);
  });

  test("declares the complete daily-work v1 surface", () => {
    expect(Object.keys(mailCapabilities.types).sort()).toEqual([
      "attachment",
      "comment",
      "conversation",
      "delivery",
      "draft",
      "folder",
      "mailbox",
      "mailing-list",
      "message",
      "reminder",
      "sender-identity",
      "tag",
    ]);
    expect(Object.keys(mailCapabilities.queries).sort()).toEqual([
      "attachment.read",
      "attachment.read-content",
      "comment.read",
      "conversation.activity.list",
      "conversation.comment.list",
      "conversation.focus",
      "conversation.list",
      "conversation.read",
      "conversation.related",
      "conversation.reminder.get",
      "conversation.search",
      "delivery.list",
      "delivery.read",
      "draft.list",
      "draft.read",
      "draft.send.review",
      "folder.list",
      "mailbox.identity.list",
      "mailbox.list",
      "mailbox.member.list",
      "mailbox.read",
      "mailbox.tag.list",
      "mailing-list.subscription.get",
      "mailing-list.subscription.list",
      "message.list",
      "message.read",
      "reminder.read",
      "search",
    ]);
    expect(Object.keys(mailCapabilities.actions).sort()).toEqual([
      "conversation.assign",
      "conversation.comment.create",
      "conversation.comment.delete",
      "conversation.comment.update",
      "conversation.mark",
      "conversation.move",
      "conversation.reminder.cancel",
      "conversation.reminder.set",
      "conversation.snooze",
      "conversation.status.update",
      "conversation.tag.update",
      "delivery.cancel",
      "draft.attachment.add",
      "draft.attachment.remove",
      "draft.create",
      "draft.discard",
      "draft.send",
      "draft.update",
      "mailbox.tag.create",
      "mailbox.tag.delete",
      "mailbox.tag.update",
      "mailing-list.unsubscribe",
    ]);
    expect(
      Object.entries(mailCapabilities.actions)
        .filter(([, action]) => "review" in action && action.review)
        .map(([id]) => id)
        .sort(),
    ).toEqual([
      "conversation.assign",
      "conversation.comment.create",
      "conversation.comment.delete",
      "conversation.comment.update",
      "conversation.mark",
      "conversation.move",
      "conversation.reminder.cancel",
      "conversation.reminder.set",
      "conversation.snooze",
      "conversation.status.update",
      "conversation.tag.update",
      "delivery.cancel",
      "draft.attachment.add",
      "draft.attachment.remove",
      "draft.create",
      "draft.discard",
      "draft.send",
      "draft.update",
      "mailbox.tag.create",
      "mailbox.tag.delete",
      "mailbox.tag.update",
      "mailing-list.unsubscribe",
    ]);
  });

  test("uses singular conversation mutations and agent-oriented discovery wording", () => {
    const target = {
      conversationId,
      sourceFolderId: folderId,
    };
    expect(
      ConversationMarkInputSchema.safeParse({
        mailboxId,
        target,
        read: false,
      }).success,
    ).toBeTrue();
    expect(
      ConversationMarkInputSchema.safeParse({
        mailboxId,
        targets: [target, target],
        read: false,
      }).success,
    ).toBeFalse();
    expect(
      ConversationMoveInputSchema.safeParse({
        mailboxId,
        target,
        destination: { kind: "role", role: "archive" },
      }).success,
    ).toBeTrue();
    expect(mailCapabilities.actions["conversation.mark"].description).toContain("read, unread, flagged, or unflagged");
    expect(mailCapabilities.actions["draft.send"].title).toBe("Send mail");
    expect(mailCapabilities.queries["draft.send.review"].description).toContain("does not send");
  });

  test("rejects UUIDs at the public Mail resource boundary", () => {
    expect(DraftCreateInputSchema.safeParse({ mailboxId, senderIdentityId }).success).toBeTrue();
    expect(DraftCreateInputSchema.safeParse({ mailboxId: internalMailboxId, senderIdentityId }).success).toBeFalse();
    expect(DraftCreateInputSchema.safeParse({ mailboxId, senderIdentityId: internalConversationId }).success).toBeFalse();
    expect(
      ConversationMarkInputSchema.safeParse({
        mailboxId,
        target: { conversationId: internalConversationId, sourceFolderId: folderId },
        read: true,
      }).success,
    ).toBeFalse();
  });

  test("aligns action reviews with their run permissions", async () => {
    const denied = { ok: false as const, error: { code: "FORBIDDEN", message: "Denied", status: 403 as const } };
    const requirePermission = spyOn(mailboxAccess, "requireMailboxPermission").mockResolvedValue(denied);

    await mailCapabilities.actions["draft.create"].review(DraftCreateInputSchema.parse({ mailboxId, senderIdentityId }), context);
    await mailCapabilities.actions["delivery.cancel"].review({ mailboxId, deliveryId, disposition: "draft" }, context);
    await mailCapabilities.actions["mailbox.tag.update"].review({ mailboxId, tagId, expectedRevision: 1, name: "Updated" }, context);
    await mailCapabilities.actions["mailbox.tag.delete"].review({ mailboxId, tagId, expectedRevision: 1 }, context);
    await mailCapabilities.actions["mailing-list.unsubscribe"].review(
      { mailboxId, listKey: "example", href: "https://example.test/unsubscribe" },
      context,
    );
    await mailCapabilities.actions["conversation.reminder.set"].review(
      { mailboxId, conversationId, dueAt: "2026-08-05T10:00:00.000Z", expectedRevision: null },
      context,
    );

    expect(requirePermission.mock.calls.slice(0, 5).map((call) => call[2])).toEqual(["write", "write", "write", "write", "write"]);
    expect(requirePermission.mock.calls[5]?.[2]).toBe("read");
  });

  test("reviews a new draft with its user-visible envelope", async () => {
    spyOn(mailboxAccess, "requireMailboxPermission").mockResolvedValue({ ok: true, data: "write" });
    const review = await mailCapabilities.actions["draft.create"].review(
      DraftCreateInputSchema.parse({
        mailboxId,
        senderIdentityId,
        to: [{ name: "Ada", address: "ada@example.test" }],
        cc: [{ address: "team@example.test" }],
        subject: "Release follow-up",
        body: "Hello Ada,\n\nThe release is ready.",
        attachments: [{ filename: "notes.txt", contentType: "text/plain", base64: "bm90ZXM=" }],
      }),
      context,
    );

    expect(review).toEqual({
      ok: true,
      data: {
        message: "The email will be saved as a draft and will not be sent.",
        approvalScope: `mailbox:${mailboxId}`,
        details: [
          { label: "Subject", value: "Release follow-up" },
          { label: "Recipients", value: "Ada, team@example.test" },
          { label: "Attachments", value: "1" },
          { label: "Body", value: "Hello Ada,\n\nThe release is ready.", display: "block" },
        ],
      },
    });
    if (review.ok) expect(CapabilityActionReviewSchema.safeParse(review.data).success).toBeTrue();
  });

  test("reviews a draft update with a disclosed bounded plain-text body preview", async () => {
    spyOn(mailboxAccess, "requireMailboxPermission").mockResolvedValue({ ok: true, data: "write" });
    spyOn(drafts, "getDraft").mockResolvedValue({
      ok: true,
      data: {
        id: internalDraftId,
        mailboxId: internalMailboxId,
        conversationId: null,
        intent: "new",
        sourceMessageId: null,
        derivedFromMessageId: null,
        derivationKind: null,
        senderIdentityId: internalConversationId,
        to: [],
        cc: [],
        bcc: [],
        subject: "Old subject",
        body: "Old body",
        format: "markdown",
        priority: "normal",
        requestDeliveryReceipt: false,
        requestReadReceipt: false,
        attachments: [],
        createdBy: { kind: "user", userId },
        lastEditedBy: { kind: "user", userId },
        lastEditedByDisplayName: "Ada",
        recoveryCopyCount: 0,
        revision: 2,
        state: "draft",
        deliveryClass: "normal",
        createdAt: "2026-08-18T10:00:00.000Z",
        updatedAt: "2026-08-18T10:00:00.000Z",
      },
    } as never);
    const proposedBody = `Hello **Ada**\n\n<script>alert('plain text')</script>\n${"x".repeat(10_500)}`;
    const input = DraftUpdateInputSchema.parse({
      mailboxId,
      draftId,
      expectedRevision: 2,
      draft: {
        senderIdentityId,
        to: [{ name: "Ada", address: "ada@example.test" }],
        subject: "New subject",
        body: proposedBody,
      },
    });

    const review = await mailCapabilities.actions["draft.update"].review(input, context);

    if (!review.ok) throw new Error("Expected a draft update review");
    expect(review.data.details).toContainEqual({
      label: "Preview warning",
      value: "This preview is truncated to 10 KB. Review the full proposed body in Details before approving.",
    });
    const preview = review.data.details?.find((detail) => detail.label === "Proposed body preview");
    expect(preview?.display).toBe("block");
    expect(Buffer.byteLength(preview?.value ?? "", "utf8")).toBe(10_000);
    expect(proposedBody.startsWith(preview?.value ?? "")).toBeTrue();
    expect(preview?.value).not.toBe(proposedBody);
    expect(CapabilityActionReviewSchema.safeParse(review.data).success).toBeTrue();
  });

  test("shows the current body directly in the send approval", async () => {
    spyOn(mailboxAccess, "requireMailboxPermission").mockResolvedValue({ ok: true, data: "write" });
    spyOn(drafts, "getDraft").mockResolvedValue({
      ok: true,
      data: {
        id: internalDraftId,
        mailboxId: internalMailboxId,
        conversationId: null,
        intent: "new",
        sourceMessageId: null,
        derivedFromMessageId: null,
        derivationKind: null,
        senderIdentityId: internalConversationId,
        to: [{ name: "Ada", address: "ada@example.test" }],
        cc: [],
        bcc: [],
        subject: "Release follow-up",
        body: "Hello Ada,\n\nThe release is ready.",
        format: "markdown",
        priority: "normal",
        requestDeliveryReceipt: false,
        requestReadReceipt: false,
        attachments: [],
        createdBy: { kind: "user", userId },
        lastEditedBy: { kind: "user", userId },
        lastEditedByDisplayName: "Ada",
        recoveryCopyCount: 0,
        revision: 2,
        state: "draft",
        deliveryClass: "normal",
        createdAt: "2026-08-18T10:00:00.000Z",
        updatedAt: "2026-08-18T10:00:00.000Z",
      },
    } as never);
    spyOn(composeSafety, "reviewDraftComposeSafety").mockResolvedValue({ ok: true, data: { warnings: [] } } as never);

    const review = await mailCapabilities.actions["draft.send"].review(
      DraftSendInputSchema.parse({ mailboxId, draftId, senderIdentityId, expectedRevision: 2 }),
      context,
    );

    if (!review.ok) throw new Error("Expected a send review");
    const parsedReview = CapabilityActionReviewSchema.parse(review.data);
    expect(parsedReview.details).toContainEqual({
      label: "Body",
      value: "Hello Ada,\n\nThe release is ready.",
      display: "block",
    });
  });

  test("keeps remote conversation subjects inside the review envelope", async () => {
    spyOn(mailboxAccess, "requireMailboxPermission").mockResolvedValue({ ok: true, data: "write" });
    spyOn(messages, "listConversationMessages").mockResolvedValue({
      ok: true,
      data: { items: [{ subject: "s".repeat(998) }], nextCursor: null },
    } as never);
    const review = await mailCapabilities.actions["conversation.mark"].review(
      { mailboxId, target: { conversationId, sourceFolderId: folderId }, read: false },
      context,
    );
    expect(review.ok).toBeTrue();
    if (review.ok) expect(CapabilityActionReviewSchema.safeParse(review.data).success).toBeTrue();
  });

  test("resolves an assignee to a current mailbox member in the review", async () => {
    spyOn(mailboxAccess, "requireMailboxPermission").mockResolvedValue({ ok: true, data: "write" });
    spyOn(messages, "listConversationMessages").mockResolvedValue({
      ok: true,
      data: { items: [{ subject: "Release follow-up" }], nextCursor: null },
    } as never);
    const listCurrentUsers = spyOn(collaboration, "listCurrentUsers").mockResolvedValue([
      { id: userId, uid: "ada", displayName: "Ada Lovelace", avatarHash: null },
    ] as never);

    const review = await mailCapabilities.actions["conversation.assign"].review(
      { mailboxId, conversationId, assigneeUserId: userId, expectedRevision: 4 },
      context,
    );

    expect(listCurrentUsers).toHaveBeenCalledWith({
      mailboxId: internalMailboxId,
      userIds: [userId],
      minimumPermission: "write",
      limit: 1,
    });
    expect(review).toMatchObject({
      ok: true,
      data: {
        message: "Assign Release follow-up to Ada Lovelace.",
        approvalScope: `mailbox:${mailboxId}`,
        details: [
          { label: "Conversation", value: "Release follow-up" },
          { label: "Assignee", value: "Ada Lovelace · ada" },
        ],
      },
    });
  });

  test("shows the current and replacement comment directly in the review", async () => {
    spyOn(mailboxAccess, "requireMailboxPermission").mockResolvedValue({ ok: true, data: "write" });
    spyOn(messages, "listConversationMessages").mockResolvedValue({
      ok: true,
      data: { items: [{ subject: "Release follow-up" }], nextCursor: null },
    } as never);
    spyOn(collaboration, "getConversationComment").mockResolvedValue({
      ok: true,
      data: { revision: 3, body: "Current line\n\nMore context" },
    } as never);

    const review = await mailCapabilities.actions["conversation.comment.update"].review(
      {
        mailboxId,
        conversationId,
        commentId,
        expectedRevision: 3,
        body: "Replacement line\n\nNew context",
      },
      context,
    );

    expect(review).toMatchObject({
      ok: true,
      data: {
        details: [
          { label: "Conversation", value: "Release follow-up" },
          { label: "Current comment", value: "Current line\n\nMore context", display: "block" },
          { label: "Replacement comment", value: "Replacement line\n\nNew context", display: "block" },
        ],
      },
    });
  });

  test("returns a valid mailbox scope from every rememberable action review", async () => {
    spyOn(mailboxAccess, "requireMailboxPermission").mockResolvedValue({ ok: true, data: "write" });
    spyOn(drafts, "getDraft").mockResolvedValue({ ok: true, data: draftFixture } as never);
    spyOn(messages, "listConversationMessages").mockResolvedValue({
      ok: true,
      data: { items: [{ subject: "Planning session" }], nextCursor: null },
    } as never);
    spyOn(localTags, "listLocalTags").mockResolvedValue({
      ok: true,
      data: [{ ...tagFixture, id: internalConversationId }],
    } as never);
    spyOn(collaboration, "listCurrentUsers").mockResolvedValue([
      { id: userId, uid: "ada", displayName: "Ada Lovelace", avatarHash: null },
    ] as never);
    spyOn(collaboration, "getConversationComment").mockResolvedValue({ ok: true, data: commentFixture } as never);
    spyOn(reminders, "getConversationReminder").mockResolvedValue({ ok: true, data: reminderFixture } as never);

    const results = [
      await mailCapabilities.actions["draft.create"].review(
        DraftCreateInputSchema.parse({ mailboxId, senderIdentityId, subject: "Release follow-up" }),
        context,
      ),
      await mailCapabilities.actions["draft.update"].review(
        DraftUpdateInputSchema.parse({
          mailboxId,
          draftId,
          expectedRevision: 2,
          draft: { senderIdentityId, subject: "Updated release follow-up" },
        }),
        context,
      ),
      await mailCapabilities.actions["draft.attachment.add"].review(
        {
          mailboxId,
          draftId,
          expectedRevision: 2,
          attachment: { filename: "notes.pdf", contentType: "application/pdf", base64: "bm90ZXM=" },
        },
        context,
      ),
      await mailCapabilities.actions["conversation.mark"].review(
        { mailboxId, target: { conversationId, sourceFolderId: folderId }, read: true },
        context,
      ),
      await mailCapabilities.actions["conversation.tag.update"].review(
        { mailboxId, conversationId, expectedRevision: 4, addTagIds: [tagId], removeTagIds: [] },
        context,
      ),
      await mailCapabilities.actions["conversation.assign"].review(
        { mailboxId, conversationId, expectedRevision: 4, assigneeUserId: userId },
        context,
      ),
      await mailCapabilities.actions["conversation.status.update"].review(
        { mailboxId, conversationId, expectedRevision: 4, status: "done" },
        context,
      ),
      await mailCapabilities.actions["conversation.snooze"].review(
        { mailboxId, conversationId, expectedRevision: 4, snoozedUntil: timestamp },
        context,
      ),
      await mailCapabilities.actions["conversation.reminder.set"].review(
        { mailboxId, conversationId, dueAt: timestamp, expectedRevision: null },
        context,
      ),
      await mailCapabilities.actions["conversation.reminder.cancel"].review({ mailboxId, conversationId, expectedRevision: 2 }, context),
      await mailCapabilities.actions["conversation.comment.create"].review(
        { mailboxId, conversationId, body: "Internal context" },
        context,
      ),
      await mailCapabilities.actions["conversation.comment.update"].review(
        { mailboxId, conversationId, commentId, expectedRevision: 3, body: "Updated context" },
        context,
      ),
      await mailCapabilities.actions["mailbox.tag.create"].review({ mailboxId, name: "customer", color: "#336699" }, context),
    ];
    const rememberableCount = (Object.values(mailCapabilities.actions) as CapabilityActionDefinition[]).filter(
      (action) => action.approval === "rememberable",
    ).length;

    expect(results).toHaveLength(rememberableCount);
    for (const result of results) {
      expect(result.ok).toBeTrue();
      if (!result.ok) continue;
      const parsed = CapabilityActionReviewSchema.safeParse(result.data);
      if (!parsed.success) throw new Error(parsed.error.message);
      expect(parsed.data.approvalScope).toBe(`mailbox:${mailboxId}`);
    }
  });

  test("returns a schema-valid user outcome from every Mail action", async () => {
    spyOn(mailboxAccess, "requireMailboxPermission").mockResolvedValue({ ok: true, data: "write" });
    spyOn(messages, "listConversationMessages").mockResolvedValue({
      ok: true,
      data: { items: [{ subject: "Planning session" }], nextCursor: null },
    } as never);
    spyOn(drafts, "materializeDraftSeed").mockResolvedValue({ ok: true, data: draftFixture } as never);
    spyOn(drafts, "updateDraft").mockResolvedValue({ ok: true, data: draftFixture } as never);
    spyOn(drafts, "getDraft").mockResolvedValue({ ok: true, data: draftFixture } as never);
    spyOn(drafts, "discardDraft").mockResolvedValue({ ok: true, data: undefined } as never);
    spyOn(draftUploads, "uploadDraftAttachmentStream").mockResolvedValue({ ok: true, data: draftFixture } as never);
    spyOn(drafts, "removeDraftAttachment").mockResolvedValue({
      ok: true,
      data: { ...draftFixture, attachments: [], revision: 3 },
    } as never);
    spyOn(commands, "createActorCommand").mockResolvedValue({
      ok: true,
      data: { id: "aaaaaaaa-0000-4000-8000-000000000001", state: "queued" },
    } as never);
    spyOn(scheduledSends, "getScheduledSend").mockResolvedValue({
      ok: true,
      data: { subject: "Release follow-up", scheduledAt: timestamp },
    } as never);
    spyOn(scheduledSends, "cancelScheduledSend").mockResolvedValue({
      ok: true,
      data: { disposition: "draft", draftId: internalDraftId },
    } as never);
    spyOn(triage, "createConversationTriageCommands").mockResolvedValue({
      ok: true,
      data: {
        correlationId: "mail-summary-test",
        commands: [{ id: "aaaaaaaa-0000-4000-8000-000000000002", state: "queued" }],
      },
    } as never);
    spyOn(localTags, "getConversationLocalTags").mockResolvedValue({
      ok: true,
      data: { conversationId: internalConversationId, conversationRevision: 4, tags: [] },
    } as never);
    spyOn(localTags, "setConversationLocalTags").mockResolvedValue({
      ok: true,
      data: { conversationId: internalConversationId, conversationRevision: 5, tags: [{ ...tagFixture, id: internalConversationId }] },
    } as never);
    spyOn(collaboration, "updateConversationCollaboration").mockResolvedValue({ ok: true, data: collaborationFixture } as never);
    spyOn(reminders, "setConversationReminder").mockResolvedValue({ ok: true, data: reminderFixture } as never);
    spyOn(reminders, "cancelConversationReminder").mockResolvedValue({
      ok: true,
      data: { ...reminderFixture, state: "canceled", revision: 3 },
    } as never);
    spyOn(collaboration, "createConversationComment").mockResolvedValue({ ok: true, data: commentFixture } as never);
    spyOn(collaboration, "getConversationComment").mockResolvedValue({ ok: true, data: commentFixture } as never);
    spyOn(collaboration, "updateConversationComment").mockResolvedValue({ ok: true, data: commentFixture } as never);
    spyOn(collaboration, "deleteConversationComment").mockResolvedValue({
      ok: true,
      data: { ...commentFixture, body: null, deletedAt: timestamp, revision: 4 },
    } as never);
    spyOn(localTags, "createLocalTag").mockResolvedValue({ ok: true, data: tagFixture } as never);
    spyOn(localTags, "updateLocalTag").mockResolvedValue({ ok: true, data: tagFixture } as never);
    spyOn(localTags, "listLocalTags").mockResolvedValue({
      ok: true,
      data: [{ ...tagFixture, id: internalConversationId }],
    } as never);
    spyOn(localTags, "deleteLocalTag").mockResolvedValue({ ok: true, data: undefined } as never);
    spyOn(listSubscriptions, "getSubscription").mockResolvedValue({
      ok: true,
      data: {
        listKey: "example",
        name: "Example Newsletter",
        address: "newsletter@example.test",
        unsubscribe: { kind: "one_click", href: "https://example.test/unsubscribe" },
      },
    } as never);
    spyOn(listSubscriptions, "requestUnsubscribe").mockResolvedValue({
      ok: true,
      data: { listKey: "example", status: "unsubscribe_requested", requestedAt: timestamp },
    } as never);

    const idempotentContext = { ...context, idempotencyKey: "mail-summary-test" };
    const results = [
      {
        localId: "draft.create",
        action: mailCapabilities.actions["draft.create"],
        run: () =>
          mailCapabilities.actions["draft.create"].run(
            DraftCreateInputSchema.parse({ mailboxId, senderIdentityId, subject: "Release follow-up" }),
            idempotentContext,
          ),
      },
      {
        localId: "draft.update",
        action: mailCapabilities.actions["draft.update"],
        run: () =>
          mailCapabilities.actions["draft.update"].run(
            DraftUpdateInputSchema.parse({
              mailboxId,
              draftId,
              expectedRevision: 2,
              draft: { senderIdentityId, subject: "Release follow-up" },
            }),
            context,
          ),
      },
      {
        localId: "draft.discard",
        action: mailCapabilities.actions["draft.discard"],
        run: () => mailCapabilities.actions["draft.discard"].run({ mailboxId, draftId, expectedRevision: 2 }, context),
      },
      {
        localId: "draft.attachment.add",
        action: mailCapabilities.actions["draft.attachment.add"],
        run: () =>
          mailCapabilities.actions["draft.attachment.add"].run(
            {
              mailboxId,
              draftId,
              expectedRevision: 2,
              attachment: { filename: "notes.pdf", contentType: "application/pdf", base64: "bm90ZXM=" },
            },
            context,
          ),
      },
      {
        localId: "draft.attachment.remove",
        action: mailCapabilities.actions["draft.attachment.remove"],
        run: () =>
          mailCapabilities.actions["draft.attachment.remove"].run(
            { mailboxId, draftId, attachmentId: draftAttachmentId, expectedRevision: 2 },
            context,
          ),
      },
      {
        localId: "draft.send",
        action: mailCapabilities.actions["draft.send"],
        run: () =>
          mailCapabilities.actions["draft.send"].run(
            DraftSendInputSchema.parse({ mailboxId, draftId, senderIdentityId, expectedRevision: 2 }),
            idempotentContext,
          ),
      },
      {
        localId: "delivery.cancel",
        action: mailCapabilities.actions["delivery.cancel"],
        run: () => mailCapabilities.actions["delivery.cancel"].run({ mailboxId, deliveryId, disposition: "draft" }, context),
      },
      {
        localId: "conversation.mark",
        action: mailCapabilities.actions["conversation.mark"],
        run: () =>
          mailCapabilities.actions["conversation.mark"].run(
            { mailboxId, target: { conversationId, sourceFolderId: folderId }, read: true, flagged: true },
            idempotentContext,
          ),
      },
      {
        localId: "conversation.move",
        action: mailCapabilities.actions["conversation.move"],
        run: () =>
          mailCapabilities.actions["conversation.move"].run(
            { mailboxId, target: { conversationId, sourceFolderId: folderId }, destination: { kind: "role", role: "archive" } },
            idempotentContext,
          ),
      },
      {
        localId: "conversation.tag.update",
        action: mailCapabilities.actions["conversation.tag.update"],
        run: () =>
          mailCapabilities.actions["conversation.tag.update"].run(
            { mailboxId, conversationId, expectedRevision: 4, addTagIds: [tagId], removeTagIds: [] },
            context,
          ),
      },
      {
        localId: "conversation.assign",
        action: mailCapabilities.actions["conversation.assign"],
        run: () =>
          mailCapabilities.actions["conversation.assign"].run(
            { mailboxId, conversationId, expectedRevision: 4, assigneeUserId: userId },
            context,
          ),
      },
      {
        localId: "conversation.status.update",
        action: mailCapabilities.actions["conversation.status.update"],
        run: () =>
          mailCapabilities.actions["conversation.status.update"].run(
            { mailboxId, conversationId, expectedRevision: 4, status: "done" },
            context,
          ),
      },
      {
        localId: "conversation.snooze",
        action: mailCapabilities.actions["conversation.snooze"],
        run: () =>
          mailCapabilities.actions["conversation.snooze"].run(
            { mailboxId, conversationId, expectedRevision: 4, snoozedUntil: timestamp },
            context,
          ),
      },
      {
        localId: "conversation.reminder.set",
        action: mailCapabilities.actions["conversation.reminder.set"],
        run: () =>
          mailCapabilities.actions["conversation.reminder.set"].run(
            { mailboxId, conversationId, dueAt: timestamp, expectedRevision: null },
            context,
          ),
      },
      {
        localId: "conversation.reminder.cancel",
        action: mailCapabilities.actions["conversation.reminder.cancel"],
        run: () =>
          mailCapabilities.actions["conversation.reminder.cancel"].run({ mailboxId, conversationId, expectedRevision: 2 }, context),
      },
      {
        localId: "conversation.comment.create",
        action: mailCapabilities.actions["conversation.comment.create"],
        run: () =>
          mailCapabilities.actions["conversation.comment.create"].run(
            { mailboxId, conversationId, body: "Internal context", referencedMessageId: null },
            context,
          ),
      },
      {
        localId: "conversation.comment.update",
        action: mailCapabilities.actions["conversation.comment.update"],
        run: () =>
          mailCapabilities.actions["conversation.comment.update"].run(
            { mailboxId, conversationId, commentId, expectedRevision: 3, body: "Updated context" },
            context,
          ),
      },
      {
        localId: "conversation.comment.delete",
        action: mailCapabilities.actions["conversation.comment.delete"],
        run: () =>
          mailCapabilities.actions["conversation.comment.delete"].run(
            { mailboxId, conversationId, commentId, expectedRevision: 3 },
            context,
          ),
      },
      {
        localId: "mailbox.tag.create",
        action: mailCapabilities.actions["mailbox.tag.create"],
        run: () => mailCapabilities.actions["mailbox.tag.create"].run({ mailboxId, name: "customer", color: "#336699" }, context),
      },
      {
        localId: "mailbox.tag.update",
        action: mailCapabilities.actions["mailbox.tag.update"],
        run: () => mailCapabilities.actions["mailbox.tag.update"].run({ mailboxId, tagId, expectedRevision: 2, name: "customer" }, context),
      },
      {
        localId: "mailbox.tag.delete",
        action: mailCapabilities.actions["mailbox.tag.delete"],
        run: () => mailCapabilities.actions["mailbox.tag.delete"].run({ mailboxId, tagId, expectedRevision: 2 }, context),
      },
      {
        localId: "mailing-list.unsubscribe",
        action: mailCapabilities.actions["mailing-list.unsubscribe"],
        run: () =>
          mailCapabilities.actions["mailing-list.unsubscribe"].run(
            { mailboxId, listKey: "example", href: "https://example.test/unsubscribe" },
            context,
          ),
      },
    ];

    expect(results).toHaveLength(Object.keys(mailCapabilities.actions).length);
    expect(new Set(results.map((item) => item.localId)).size).toBe(results.length);
    const summaries = new Map<string, string>();
    const actionOutputs: unknown[] = [];
    for (const { localId, action, run } of results) {
      const result = await run().catch((error) => {
        throw new Error(`Mail action ${localId} threw`, { cause: error });
      });
      expect(result.ok).toBeTrue();
      if (!result.ok) continue;
      expect(result.data.summary?.length).toBeGreaterThan(0);
      summaries.set(localId, result.data.summary ?? "");
      actionOutputs.push(result.data);
      const parsed = capabilityResultSchema(action.data).safeParse(result.data);
      if (!parsed.success) throw new Error(`Invalid Mail result for ${localId}: ${parsed.error.message}`);
    }
    expect(Object.fromEntries(summaries)).toMatchObject({
      "draft.create": "Created draft “Release follow-up”.",
      "draft.attachment.add": "Added notes.pdf to draft “Release follow-up”.",
      "draft.send": "Queued “Release follow-up” for delivery.",
      "delivery.cancel": "Cancelled delivery of “Release follow-up” and restored it as a draft.",
      "conversation.mark": "Marked “Planning session” as read and flagged.",
      "conversation.assign": "Assigned “Planning session” to Ada Lovelace.",
      "mailbox.tag.create": "Created mailbox tag #customer.",
      "mailing-list.unsubscribe": "Requested unsubscribe from Example Newsletter.",
    });
    expect(JSON.stringify(actionOutputs)).not.toContain(draftFixture.body);
    expect(JSON.stringify(actionOutputs)).not.toContain(commentFixture.body);
  });

  test("resolves short mailbox IDs and paginates folders with public IDs", async () => {
    const folder = (id: string, name: string) => ({
      id,
      parentId: null,
      name,
      role: "custom",
      providerRole: "custom",
      configuredRole: null,
      selectable: true,
      showInSidebar: true,
      namespaceKinds: ["personal" as const],
      discoveryState: "active" as const,
      missingSince: null,
      syncStatus: "current",
      total: 0,
      unread: 0,
    });
    const listFolders = spyOn(messages, "listFolders").mockResolvedValue({
      ok: true,
      data: [folder(internalFolderCId, "C"), folder(internalFolderAId, "A"), folder(internalFolderBId, "B")],
    });

    const first = await mailCapabilities.queries["folder.list"].run({ mailboxId, limit: 2 }, context);
    expect(listFolders.mock.calls[0]?.[1]).toBe(internalMailboxId);
    expect(first).toMatchObject({
      ok: true,
      data: {
        data: [
          {
            ref: { type: "mail.folder", id: folderAId },
            title: "A",
            links: [{ rel: "open", href: `/app/mail/${mailboxId}?folder=${folderAId}` }],
          },
          {
            ref: { type: "mail.folder", id: folderBId },
            title: "B",
            links: [{ rel: "open", href: `/app/mail/${mailboxId}?folder=${folderBId}` }],
          },
        ],
        page: { hasMore: true },
      },
    });
    if (!first.ok || !first.data.page?.hasMore) throw new Error("Expected another folder page");
    expect(FolderListDataSchema.safeParse(first.data.data).success).toBeTrue();
    const second = await mailCapabilities.queries["folder.list"].run({ mailboxId, limit: 2, cursor: first.data.page.nextCursor }, context);
    expect(second).toMatchObject({
      ok: true,
      data: { data: [{ ref: { type: "mail.folder", id: folderCId }, title: "C" }], page: { hasMore: false } },
    });
  });

  test("keeps the decision fields and link with each compact conversation item", async () => {
    spyOn(messages, "listConversations").mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            id: internalConversationId,
            primaryReference: null,
            subject: "Release update",
            participantSummary: "Ada",
            participantLabels: ["Ada"],
            latestMessageAt: "2026-08-04T10:00:00.000Z",
            workStatus: "needs_action",
            assigneeUserId: null,
            snoozedUntil: null,
            revision: 1,
            updatedAt: "2026-08-04T10:00:00.000Z",
            unread: true,
            activeFolderIds: [internalFolderId],
            flagged: false,
            hasAttachments: false,
            messageCount: 1,
            preview: "Ready to ship",
          },
        ],
        nextCursor: null,
      },
    } as never);

    const result = await mailCapabilities.queries["conversation.list"].run({ mailboxId, limit: 25 }, context);
    expect(result).toMatchObject({
      ok: true,
      data: {
        data: [
          {
            ref: { type: "mail.conversation", id: conversationId },
            title: "Release update",
            participants: "Ada",
            preview: "Ready to ship",
            unread: true,
            messageCount: 1,
            links: [{ rel: "open", href: `/app/mail/${mailboxId}?conversation=${conversationId}` }],
          },
        ],
      },
    });
    if (!result.ok) throw new Error("Expected conversation list success");
    expect(ConversationListDataSchema.safeParse(result.data.data).success).toBeTrue();
    expect(ConversationListDataSchema.safeParse(result.data.data.map(({ links: _, ...item }) => item)).success).toBeFalse();
    expect(JSON.stringify(result)).not.toContain(internalConversationId);
    expect(JSON.stringify(result)).not.toContain(internalMailboxId);
  });

  test("lists focused conversations across mailboxes with public links", async () => {
    spyOn(focus, "listFocusConversations").mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            id: internalConversationId,
            mailboxId: internalMailboxId,
            mailboxName: "Support",
            subject: "Release update",
            participantSummary: "Ada",
            latestMessageAt: "2026-08-04T10:00:00.000Z",
            workStatus: "needs_action",
            assigneeUserId: userId,
            unread: true,
            flagged: false,
            hasAttachments: false,
            preview: "Ready to ship",
          },
        ],
        counts: { mine: 1, unassigned: 0, waiting: 0, all: 1 },
        mailboxCounts: [{ mailboxId: internalMailboxId, unread: 1, needsAction: 1 }],
        nextCursor: "next-focus-page",
      },
    });

    const result = await mailCapabilities.queries["conversation.focus"].run({ view: "mine", limit: 25 }, context);
    expect(result).toMatchObject({
      ok: true,
      data: {
        data: [
          {
            ref: { type: "mail.conversation", id: conversationId },
            title: "Release update",
            mailboxId,
            mailboxName: "Support",
            links: [{ rel: "open", href: `/app/mail/${mailboxId}?conversation=${conversationId}` }],
          },
        ],
        page: { nextCursor: "next-focus-page" },
      },
    });
    if (!result.ok) throw new Error("Expected conversation focus success");
    expect(ConversationFocusListDataSchema.safeParse(result.data.data).success).toBeTrue();
    expect(JSON.stringify(result)).not.toContain(internalConversationId);
    expect(JSON.stringify(result)).not.toContain(internalMailboxId);
  });

  test("returns a typed ref and pagination envelope for draft lists", async () => {
    const listDrafts = spyOn(drafts, "listDrafts").mockResolvedValue({ ok: true, data: [draftFixture] } as never);
    const result = await mailCapabilities.queries["draft.list"].run({ mailboxId, limit: 25 }, context);

    expect(listDrafts.mock.calls[0]?.[2]).toBe(200);
    expect(result).toMatchObject({
      ok: true,
      data: {
        data: [{ ref: { type: "mail.draft", id: draftId }, title: "Release follow-up", recipients: "Ada", revision: 2 }],
        page: { hasMore: false },
      },
    });
    if (!result.ok) throw new Error("Expected draft list success");
    expect(DraftListDataSchema.safeParse(result.data.data).success).toBeTrue();
  });

  test("names the missing resource type in reader errors", async () => {
    const missing = "XyZ123";
    const mailbox = await mailCapabilities.queries["mailbox.read"].run({ id: missing }, context);
    const conversation = await mailCapabilities.queries["conversation.read"].run({ id: missing }, context);

    expect(mailbox).toMatchObject({ ok: false, error: { code: "NOT_FOUND", message: "Mailbox not found" } });
    expect(conversation).toMatchObject({ ok: false, error: { code: "NOT_FOUND", message: "Conversation not found" } });
  });

  test("explains attachment-content conversation matches with public links", async () => {
    spyOn(search, "searchMessages").mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            id: internalConversationId,
            conversationId: internalConversationId,
            primaryReference: null,
            subject: "Release update",
            participantSummary: "Ada",
            participantLabels: ["Ada"],
            latestMessageAt: "2026-08-04T10:00:00.000Z",
            workStatus: "needs_action",
            assigneeUserId: null,
            snoozedUntil: null,
            revision: 1,
            updatedAt: "2026-08-04T10:00:00.000Z",
            unread: true,
            activeFolderIds: [internalFolderId],
            flagged: false,
            hasAttachments: true,
            messageCount: 1,
            snippet: "Body preview",
            attachmentMatch: {
              attachmentId: internalAttachmentId,
              messageId: internalMessageId,
              filename: "roadmap.pdf",
              snippet: "Matched roadmap milestone",
              reason: "attachment_content",
            },
          },
        ],
        nextCursor: null,
      },
    } as never);

    const result = await mailCapabilities.queries["conversation.search"].run(
      {
        mailboxId,
        expression: { type: "text", field: "any", query: "roadmap milestone", match: "words" },
        sort: "relevance",
        limit: 25,
      },
      context,
    );

    if (!result.ok) throw new Error("Expected conversation search success");
    expect(ConversationSearchDataSchema.safeParse(result.data.data).success).toBeTrue();
    expect(result.data.data[0]?.attachmentMatch).toEqual({
      ref: { type: "mail.attachment", id: attachmentId },
      messageRef: { type: "mail.message", id: messageId },
      title: "roadmap.pdf",
      preview: "Matched roadmap milestone",
      links: [
        { rel: "open", href: `/app/mail/${mailboxId}?message=${messageId}` },
        {
          rel: "download",
          href: `/api/mail/mailboxes/${mailboxId}/messages/${messageId}/attachments/${attachmentId}`,
          title: "roadmap.pdf",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(internalAttachmentId);
    expect(JSON.stringify(result)).not.toContain(internalMessageId);
  });

  test("returns bounded related conversations with explainable reasons, refs, and links", async () => {
    spyOn(conversationContext, "listRelatedConversations").mockResolvedValue({
      ok: true,
      data: [
        {
          id: internalRelatedConversationId,
          subject: "Re: Release update",
          participantSummary: "Ada",
          latestMessageAt: "2026-08-04T10:00:00.000Z",
          preview: "A previous update",
          reasons: [
            { kind: "participant", value: "ada@example.test" },
            { kind: "subject", value: "Release update" },
          ],
        },
      ],
    });

    const result = await mailCapabilities.queries["conversation.related"].run({ mailboxId, conversationId, limit: 5 }, context);

    expect(result).toEqual({
      ok: true,
      data: {
        data: [
          {
            ref: { type: "mail.conversation", id: relatedConversationId },
            title: "Re: Release update",
            participants: "Ada",
            latestMessageAt: "2026-08-04T10:00:00.000Z",
            preview: "A previous update",
            reasons: [
              { kind: "participant", value: "ada@example.test" },
              { kind: "subject", value: "Release update" },
            ],
            links: [{ rel: "open", href: `/app/mail/${mailboxId}?conversation=${relatedConversationId}` }],
          },
        ],
      },
    });
    if (result.ok) expect(ConversationRelatedDataSchema.safeParse(result.data.data).success).toBeTrue();
  });

  test("reads the shared summary with the latest bounded message window", async () => {
    spyOn(resourceParents, "conversation").mockResolvedValue(internalMailboxId);
    const getSummary = spyOn(conversationSummaries, "getConversationSummary").mockResolvedValue({
      ok: true,
      data: { summary: "Launch approved; waiting for the checklist.", summaryRevision: 3, conversationRevision: 7 },
    });
    const getCollaboration = spyOn(collaboration, "getConversationCollaboration").mockResolvedValue({
      ok: true,
      data: { conversationId: internalConversationId, assignee: null, workStatus: "waiting", snoozedUntil: null, revision: 7 },
    });
    const getTags = spyOn(localTags, "getConversationLocalTags").mockResolvedValue({
      ok: true,
      data: {
        conversationId: internalConversationId,
        conversationRevision: 7,
        tags: [
          {
            id: internalTagId,
            mailboxId: internalMailboxId,
            name: "Launch",
            color: "blue",
            revision: 2,
            createdAt: "2026-08-15T10:00:00.000Z",
            updatedAt: "2026-08-15T10:00:00.000Z",
          },
        ],
      },
    });
    const listMessages = spyOn(messages, "listConversationMessages").mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            id: internalMessageId,
            subject: "Final checklist",
            messageId: "<final@example.test>",
            internalDate: "2026-08-15T11:00:00.000Z",
            sentAt: "2026-08-15T11:00:00.000Z",
            from: [{ name: "Ada", address: "ada@example.test" }],
            to: [{ name: null, address: "team@example.test" }],
            preview: "Final checklist attached.",
            hasAttachments: true,
            flags: [],
            keywords: [],
            hydrationStatus: "hydrated",
            remoteAvailable: true,
            folderId: internalFolderId,
          },
        ],
        nextCursor: "older",
      },
    });

    const result = await mailCapabilities.queries["conversation.read"].run({ id: conversationId }, context);

    expect(listMessages).toHaveBeenCalledWith({
      context: { actor: context.actor, accessSubject: context.accessSubject },
      mailboxId: internalMailboxId,
      conversationId: internalConversationId,
      limit: 5,
      latest: true,
    });
    expect(getSummary).toHaveBeenCalledTimes(1);
    expect(getCollaboration).toHaveBeenCalledTimes(1);
    expect(getTags).toHaveBeenCalledTimes(1);
    expect(listMessages).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      data: {
        summary: "Read conversation “Final checklist”.",
        data: {
          mailboxId,
          conversationId,
          summary: "Launch approved; waiting for the checklist.",
          summaryRevision: 3,
          collaboration: { workStatus: "waiting", revision: 7 },
          tags: [{ id: tagId, name: "Launch" }],
          messages: [{ ref: { type: "mail.message", id: messageId }, title: "Final checklist" }],
          messagesTruncated: true,
        },
      },
    });
    if (!result.ok) throw new Error("Expected conversation read success");
    expect(ConversationGetDataSchema.safeParse(result.data.data).success).toBeTrue();
  });

  test("lists message previews that support selective full-body reads", async () => {
    spyOn(messages, "listConversationMessages").mockResolvedValue({
      ok: true,
      data: {
        items: [
          {
            id: internalMessageId,
            subject: "Invoice review",
            preview: "Please approve invoice 4711 before Friday.",
            hasAttachments: true,
            messageId: "<invoice@example.test>",
            internalDate: "2026-08-15T11:00:00.000Z",
            sentAt: "2026-08-15T10:59:00.000Z",
            from: [{ name: "Ada", address: "ada@example.test" }],
            to: [{ name: null, address: "team@example.test" }],
            flags: ["\\Flagged"],
            keywords: ["provider-only-label"],
            hydrationStatus: "complete",
            remoteAvailable: true,
            folderId: internalFolderId,
          },
        ],
        nextCursor: null,
      },
    });

    const result = await mailCapabilities.queries["message.list"].run({ mailboxId, conversationId, limit: 25 }, context);

    if (!result.ok) throw new Error("Expected message list success");
    expect(MessageListDataSchema.safeParse(result.data.data).success).toBeTrue();
    expect(result.data.data).toEqual([
      {
        ref: { type: "mail.message", id: messageId },
        title: "Invoice review",
        preview: "Please approve invoice 4711 before Friday.",
        links: [{ rel: "open", href: `/app/mail/${mailboxId}?message=${messageId}` }],
        internalDate: "2026-08-15T11:00:00.000Z",
        sentAt: "2026-08-15T10:59:00.000Z",
        from: [{ name: "Ada", address: "ada@example.test" }],
        to: [{ name: null, address: "team@example.test" }],
        addressesTruncated: false,
        unread: true,
        flagged: true,
        hasAttachments: true,
        contentStatus: "complete",
        remoteAvailable: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("provider-only-label");
    expect(JSON.stringify(result)).not.toContain("<invoice@example.test>");
  });

  test("returns exact conversation links from reviews and mutation results", async () => {
    spyOn(mailboxAccess, "requireMailboxPermission").mockResolvedValue({ ok: true, data: "write" });
    spyOn(messages, "listConversationMessages").mockResolvedValue({
      ok: true,
      data: { items: [{ subject: "Release update" }], nextCursor: null },
    } as never);
    const createCommands = spyOn(triage, "createConversationTriageCommands").mockResolvedValue({
      ok: true,
      data: { correlationId: "correlation", commands: [{ id: internalMailboxId, state: "pending" }] },
    } as never);
    const input = { mailboxId, target: { conversationId, sourceFolderId: folderId }, read: true };

    const review = await mailCapabilities.actions["conversation.mark"].review(input, context);
    const result = await mailCapabilities.actions["conversation.mark"].run(input, { ...context, idempotencyKey: "mark-read" });

    expect(createCommands.mock.calls[0]?.[0]).toMatchObject({
      mailboxId: internalMailboxId,
      conversationId: internalConversationId,
      input: { sourceFolderId: internalFolderId },
    });
    expect(review).toMatchObject({
      ok: true,
      data: { links: [{ rel: "open", href: `/app/mail/${mailboxId}?conversation=${conversationId}` }] },
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        refs: [{ type: "mail.conversation", id: conversationId }],
        links: [{ rel: "open", href: `/app/mail/${mailboxId}?conversation=${conversationId}` }],
      },
    });
  });

  test("summarizes a tag update with the readable conversation and final state", async () => {
    spyOn(mailboxAccess, "requireMailboxPermission").mockResolvedValue({ ok: true, data: "write" });
    spyOn(messages, "listConversationMessages").mockResolvedValue({
      ok: true,
      data: { items: [{ subject: "Planning session" }], nextCursor: null },
    } as never);
    spyOn(publicResources, "resolveMailboxPublicIds").mockImplementation(async (_table, _mailboxId, ids) =>
      ids.map((id) => internalIdsByTable.tags.get(id)!).filter(Boolean),
    );
    spyOn(localTags, "getConversationLocalTags").mockResolvedValue({
      ok: true,
      data: { conversationId: internalConversationId, conversationRevision: 4, tags: [] },
    });
    spyOn(localTags, "setConversationLocalTags").mockResolvedValue({
      ok: true,
      data: {
        conversationId: internalConversationId,
        conversationRevision: 5,
        tags: [
          {
            id: internalConversationId,
            mailboxId: internalMailboxId,
            name: "customer",
            color: "blue",
            revision: 1,
            createdAt: "2026-08-20T10:00:00.000Z",
            updatedAt: "2026-08-20T10:00:00.000Z",
          },
        ],
      },
    });

    const result = await mailCapabilities.actions["conversation.tag.update"].run(
      {
        mailboxId,
        conversationId,
        expectedRevision: 4,
        addTagIds: [tagId],
        removeTagIds: [],
      },
      context,
    );

    expect(result).toMatchObject({
      ok: true,
      data: { summary: "Added #customer to “Planning session”." },
    });
  });

  test("encodes subscription links and omits links that exceed the platform bound", async () => {
    const subscription = (listKey: string) => ({
      listKey,
      name: "Example list",
      address: "list@example.test",
      status: "active" as const,
      unsubscribe: null,
      postHref: null,
      helpHref: null,
      archiveHref: null,
      messageCount: 2,
      recentMessageCount: 1,
      conversationCount: 1,
      lastMessageAt: "2026-08-04T10:00:00.000Z",
      lastSubject: "Update",
      lastSender: "Example",
      lastMessageId: internalConversationId,
      lastConversationId: internalConversationId,
      unsubscribeRequestedAt: null,
      unsubscribeErrorCode: null,
    });
    spyOn(listSubscriptions, "listSubscriptions").mockResolvedValue({
      ok: true,
      data: { items: [subscription("list one&two"), subscription("x".repeat(4096))], nextCursor: null },
    });

    const result = await mailCapabilities.queries["mailing-list.subscription.list"].run({ mailboxId, limit: 25 }, context);
    expect(result).toMatchObject({
      ok: true,
      data: {
        data: [{ links: [{ rel: "open", href: `/app/mail/${mailboxId}?mailingList=list%20one%26two` }] }, { listKey: "x".repeat(4096) }],
      },
    });
    if (!result.ok) throw new Error("Expected subscription list success");
    expect(SubscriptionListDataSchema.safeParse(result.data.data).success).toBeTrue();
    expect("links" in result.data.data[1]!).toBeFalse();
  });

  test("projects activity resource targets and resource metadata without leaking UUIDs", async () => {
    const activity = (id: string, targetType: string, targetId: string, metadata: Record<string, unknown> = {}) => ({
      id,
      conversationId: internalConversationId,
      actor: { kind: "system" as const, id: null, displayName: "System", avatarHash: null },
      action: `test.${targetType}`,
      outcome: "confirmed" as const,
      targetType,
      targetId,
      metadata,
      createdAt: "2026-08-04T10:00:00.000Z",
    });
    const listActivity = spyOn(collaboration, "listActivity").mockResolvedValue({
      ok: true,
      data: {
        items: [
          activity("1", "conversation", internalConversationId, {
            messageId: internalMessageId,
            addedTagIds: [internalTagId, missingResourceId],
          }),
          activity("2", "draft_attachment", internalDraftAttachmentId),
          activity("3", "comment", missingResourceId, { messageId: missingResourceId }),
          activity("4", "command", technicalTargetId),
          activity("5", "unknown_resource", missingResourceId),
        ],
        nextCursor: null,
      },
    } as never);

    const result = await mailCapabilities.queries["conversation.activity.list"].run({ mailboxId, limit: 25 }, context);

    expect(listActivity.mock.calls[0]?.[0]).toMatchObject({ mailboxId: internalMailboxId, conversationId: null });
    expect(result).toMatchObject({
      ok: true,
      data: {
        data: [
          {
            conversationId,
            targetType: "conversation",
            targetId: conversationId,
            metadata: { messageId, addedTagIds: [tagId, null] },
          },
          { conversationId, targetType: "draft_attachment", targetId: draftAttachmentId },
          { conversationId, targetType: "comment", targetId: null, metadata: { messageId: null } },
          { conversationId, targetType: "command", targetId: technicalTargetId },
          { conversationId, targetType: "unknown_resource", targetId: null },
        ],
        refs: [{ type: "mail.mailbox", id: mailboxId }],
        links: [{ rel: "open", href: `/app/mail/${mailboxId}` }],
      },
    });
    if (!result.ok) throw new Error("Expected activity list success");
    expect(ActivityListDataSchema.safeParse(result.data.data).success).toBeTrue();
    const projectedResourceActivities = JSON.stringify(result.data.data.slice(0, 3));
    for (const id of [internalConversationId, internalDraftAttachmentId, internalMessageId, internalTagId, missingResourceId]) {
      expect(projectedResourceActivities).not.toContain(id);
    }
  });

  test("propagates Mail search discovery failures instead of returning empty success", async () => {
    spyOn(mailboxes, "listMailboxes").mockResolvedValue({
      ok: false,
      error: { code: "INTERNAL", message: "Mailbox lookup failed", status: 500 },
    });
    const result = await mailCapabilities.queries.search.run({ query: "invoice", tags: [], limit: 10 }, context);
    expect(result).toEqual({ ok: false, error: { code: "INTERNAL", message: "Mailbox lookup failed", status: 500 } });
  });

  test("keeps draft creation bounded and closed", () => {
    const base = {
      mailboxId,
      senderIdentityId,
    };
    expect(DraftCreateInputSchema.safeParse(base).success).toBeTrue();
    expect(DraftCreateInputSchema.safeParse({ ...base, connectorPassword: "secret" }).success).toBeFalse();
    expect(
      DraftCreateInputSchema.safeParse({
        ...base,
        attachments: Array.from({ length: 11 }, (_, index) => ({ filename: `${index}.txt`, base64: "YQ==" })),
      }).success,
    ).toBeFalse();
  });

  test("requires the exact safety approval shape for sending", () => {
    const input = {
      mailboxId,
      draftId: "DrG789",
      expectedRevision: 2,
      senderIdentityId,
      safetyApproval: { revision: 2, fingerprint: "a".repeat(64), warningIds: ["missing_attachment"] },
    };
    expect(DraftSendInputSchema.safeParse(input).success).toBeTrue();
    expect(DraftSendInputSchema.safeParse({ ...input, safetyApproval: { warningIds: [] } }).success).toBeFalse();
  });

  test("does not expose raw source or sanitized html from message.read", () => {
    const value = {
      id: "MsH890",
      mailboxId,
      conversationId: null,
      subject: "Hello",
      subjectTruncated: false,
      messageId: null,
      internalDate: "2026-08-02T10:00:00.000Z",
      sentAt: null,
      from: [],
      to: [],
      addressesTruncated: false,
      flags: [],
      flagsTruncated: false,
      keywords: [],
      keywordsTruncated: false,
      hydrationStatus: "ready",
      remoteAvailable: true,
      contentType: "text/html",
      sizeBytes: 10,
      replyTo: [],
      cc: [],
      detailAddressesTruncated: false,
      headers: [{ name: "message-id", value: "<example@example.com>" }],
      headersTruncated: false,
      text: "Hello",
      bodyTruncated: false,
      attachments: [],
      attachmentsTruncated: false,
      delivery: null,
    };
    expect(MessageDataSchema.safeParse(value).success).toBeTrue();
    expect(MessageDataSchema.safeParse({ ...value, sanitizedHtml: "<b>Hello</b>" }).success).toBeFalse();
  });

  test("reads persisted attachment text through a bounded untrusted UTF-8 page after current access", async () => {
    spyOn(resourceParents, "attachment").mockResolvedValue({ mailboxId: internalMailboxId, messageId: internalMessageId });
    spyOn(messages, "getMessage").mockResolvedValue({
      ok: true,
      data: {
        attachments: [
          {
            id: internalAttachmentId,
            filename: "roadmap.pdf",
            contentType: "application/pdf",
            sizeBytes: 123,
            contentId: null,
          },
        ],
      } as never,
    });
    spyOn(attachmentExtraction, "loadAttachmentExtraction").mockResolvedValue({
      status: "complete",
      format: "pdf",
      markdown: "A😀B",
      inputBytes: 123,
      outputBytes: 6,
      truncated: false,
      errorCode: null,
      updatedAt: "2026-08-19T00:00:00.000Z",
    });

    const result = await mailCapabilities.queries["attachment.read-content"].run({ id: attachmentId, offset: 0, length: 256 }, context);
    if (!result.ok) throw new Error("Expected attachment content success");
    expect(AttachmentContentReadDataSchema.parse(result.data.data)).toMatchObject({
      id: attachmentId,
      messageId,
      markdown: "A😀B",
      length: 6,
      totalBytes: 6,
      nextOffset: null,
      trust: "untrusted",
      extraction: { status: "complete", available: true, format: "pdf" },
    });
    expect(result.data.refs).toEqual([
      { type: "mail.attachment", id: attachmentId, title: "roadmap.pdf", icon: "ti ti-paperclip" },
      { type: "mail.message", id: messageId, title: "(no subject)", icon: "ti ti-mail" },
    ]);
    expect(result.data.summary).toBe("Read attachment text from “roadmap.pdf”.");
  });

  test("keeps the canonical attachment reader metadata-only", async () => {
    spyOn(resourceParents, "attachment").mockResolvedValue({ mailboxId: internalMailboxId, messageId: internalMessageId });
    spyOn(messages, "getMessage").mockResolvedValue({
      ok: true,
      data: {
        attachments: [
          {
            id: internalAttachmentId,
            filename: "roadmap.pdf",
            contentType: "application/pdf",
            sizeBytes: 123,
            contentId: null,
          },
        ],
      } as never,
    });
    const loadMetadata = spyOn(attachmentExtraction, "loadAttachmentExtractionMetadata").mockResolvedValue({
      status: "complete",
      extractorVersion: attachmentExtraction.MAIL_ATTACHMENT_EXTRACTOR_VERSION,
      available: true,
      format: "pdf",
      inputBytes: 123,
      outputBytes: 42,
      truncated: false,
      errorCode: null,
      updatedAt: "2026-08-19T00:00:00.000Z",
    });
    const loadContent = spyOn(attachmentExtraction, "loadAttachmentExtraction");

    const result = await mailCapabilities.queries["attachment.read"].run({ id: attachmentId }, context);

    if (!result.ok) throw new Error("Expected attachment metadata result");
    expect(result.data.summary).toBe("Read attachment “roadmap.pdf”.");
    expect(AttachmentReadDataSchema.parse(result.data.data).extraction).toMatchObject({
      status: "complete",
      available: true,
      outputBytes: 42,
    });
    expect(loadMetadata).toHaveBeenCalledWith(internalAttachmentId);
    expect(loadContent).not.toHaveBeenCalled();
  });

  test("reports pending metadata and only queues missing extraction work", async () => {
    spyOn(resourceParents, "attachment").mockResolvedValue({ mailboxId: internalMailboxId, messageId: internalMessageId });
    spyOn(messages, "getMessage").mockResolvedValue({
      ok: true,
      data: {
        attachments: [
          {
            id: internalAttachmentId,
            filename: "roadmap.pdf",
            contentType: "application/pdf",
            sizeBytes: 123,
            contentId: null,
          },
        ],
      } as never,
    });
    spyOn(attachmentExtraction, "loadAttachmentExtraction").mockResolvedValue(null);
    spyOn(messages, "openAttachment").mockResolvedValue({ ok: true, data: { blobId: "blob-id" } } as never);
    const enqueue = spyOn(attachmentExtraction, "enqueueAttachmentExtraction").mockResolvedValue({ id: "job-id" } as never);

    const result = await mailCapabilities.queries["attachment.read-content"].run({ id: attachmentId, offset: 0, length: 256 }, context);

    if (!result.ok) throw new Error("Expected pending attachment content result");
    expect(AttachmentContentReadDataSchema.parse(result.data.data)).toMatchObject({
      markdown: null,
      length: 0,
      totalBytes: null,
      nextOffset: null,
      trust: "untrusted",
      extraction: { status: "pending", available: false },
    });
    expect(result.data.summary).toBe("Text extraction for “roadmap.pdf” is pending.");
    expect(enqueue).toHaveBeenCalledWith("blob-id");
  });

  test("does not load attachment extraction after current mailbox access is denied", async () => {
    spyOn(resourceParents, "attachment").mockResolvedValue({ mailboxId: internalMailboxId, messageId: internalMessageId });
    spyOn(messages, "getMessage").mockResolvedValue({
      ok: false,
      error: { code: "FORBIDDEN", message: "Forbidden", status: 403 },
    });
    const load = spyOn(attachmentExtraction, "loadAttachmentExtraction");
    const result = await mailCapabilities.queries["attachment.read-content"].run({ id: attachmentId, offset: 0, length: 256 }, context);
    expect(result).toEqual({ ok: false, error: { code: "FORBIDDEN", message: "Forbidden", status: 403 } });
    expect(load).not.toHaveBeenCalled();
  });

  test("returns BAD_INPUT for invalid UTF-8 attachment content offsets", async () => {
    spyOn(resourceParents, "attachment").mockResolvedValue({ mailboxId: internalMailboxId, messageId: internalMessageId });
    spyOn(messages, "getMessage").mockResolvedValue({
      ok: true,
      data: {
        attachments: [{ id: internalAttachmentId, filename: "emoji.txt", contentType: "text/plain", sizeBytes: 6, contentId: null }],
      } as never,
    });
    spyOn(attachmentExtraction, "loadAttachmentExtraction").mockResolvedValue({
      status: "complete",
      format: "text",
      markdown: "A😀B",
      inputBytes: 6,
      outputBytes: 6,
      truncated: false,
      errorCode: null,
      updatedAt: "2026-08-19T00:00:00.000Z",
    });

    for (const offset of [2, 7]) {
      const result = await mailCapabilities.queries["attachment.read-content"].run({ id: attachmentId, offset, length: 256 }, context);
      expect(result.ok).toBeFalse();
      if (!result.ok) expect(result.error).toMatchObject({ code: "BAD_INPUT", status: 400 });
    }
  });

  test("accepts only explicit unsubscribe targets", () => {
    const valid = {
      mailboxId,
      listKey: "example.list",
      href: "https://example.com/unsubscribe",
    };
    expect(SubscriptionUnsubscribeInputSchema.safeParse(valid).success).toBeTrue();
    expect(SubscriptionUnsubscribeInputSchema.safeParse({ ...valid, allLists: true }).success).toBeFalse();
  });

  test("keeps compact high-cardinality results below the capability transport limit", () => {
    const id = "RsA123";
    const timestamp = "2026-08-02T10:00:00.000Z";
    const drafts = Array.from({ length: 100 }, () => ({
      ref: { type: "mail.draft" as const, id },
      title: "s".repeat(500),
      preview: "b".repeat(240),
      links: [{ rel: "edit" as const, href: `/app/mail/${id}/compose/${id}` }],
      conversationId: id,
      intent: "forward" as const,
      senderIdentityId: id,
      recipients: "r".repeat(320),
      recipientsTruncated: true,
      attachmentCount: 1000,
      revision: 1,
      state: "draft" as const,
      updatedAt: timestamp,
    }));
    const comments = Array.from({ length: 100 }, () => ({
      ref: { type: "mail.comment" as const, id },
      title: "Comment by Agent",
      preview: "c".repeat(240),
      links: [{ rel: "open" as const, href: `/app/mail/${id}?conversation=${id}` }],
      author: { kind: "user" as const, displayName: "Agent" },
      referencedMessageId: null,
      revision: 1,
      canEdit: true,
      canDelete: true,
      editedAt: null,
      deleted: false,
      createdAt: timestamp,
    }));
    const parsedDrafts = DraftListDataSchema.parse(drafts);
    const parsedComments = CommentListDataSchema.parse(comments);
    expect(Buffer.byteLength(JSON.stringify({ data: parsedDrafts }), "utf8")).toBeLessThan(CAPABILITY_MAX_RESULT_BYTES);
    expect(Buffer.byteLength(JSON.stringify({ data: parsedComments }), "utf8")).toBeLessThan(CAPABILITY_MAX_RESULT_BYTES);

    const address = { name: "n".repeat(200), address: `${"a".repeat(64)}@example.test` };
    const attachmentId = "AtJ901";
    const message = MessageDataSchema.parse({
      id,
      mailboxId: id,
      conversationId: id,
      subject: "s".repeat(998),
      subjectTruncated: true,
      messageId: "m".repeat(998),
      internalDate: timestamp,
      sentAt: timestamp,
      from: Array.from({ length: 20 }, () => address),
      to: Array.from({ length: 20 }, () => address),
      addressesTruncated: true,
      flags: Array.from({ length: 10 }, () => "f".repeat(128)),
      flagsTruncated: true,
      keywords: Array.from({ length: 10 }, () => "k".repeat(128)),
      keywordsTruncated: true,
      hydrationStatus: "h".repeat(100),
      remoteAvailable: true,
      contentType: "c".repeat(255),
      sizeBytes: 1,
      replyTo: Array.from({ length: 20 }, () => address),
      cc: Array.from({ length: 20 }, () => address),
      detailAddressesTruncated: true,
      headers: Array.from({ length: 25 }, () => ({ name: "h".repeat(128), value: "v".repeat(2048) })),
      headersTruncated: true,
      text: "b".repeat(96 * 1024),
      bodyTruncated: true,
      attachments: Array.from({ length: 50 }, () => ({
        id: attachmentId,
        filename: "f".repeat(255),
        contentType: "c".repeat(255),
        sizeBytes: 1,
        downloadHref: `/api/mail/mailboxes/${id}/messages/${id}/attachments/${attachmentId}`,
      })),
      attachmentsTruncated: true,
      delivery: {
        id,
        state: "scheduled",
        scheduledAt: timestamp,
        undoUntil: timestamp,
        acceptedAt: null,
        errorCode: "e".repeat(200),
        errorMessage: "e".repeat(1000),
      },
    });
    const messageEnvelope = {
      data: message,
      refs: Array.from({ length: 50 }, () => ({ type: "mail.attachment", id: attachmentId })),
      links: Array.from({ length: 20 }, () => ({ rel: "download", href: `/api/mail/attachments/${attachmentId}` })),
    };
    expect(Buffer.byteLength(JSON.stringify(messageEnvelope), "utf8")).toBeLessThan(CAPABILITY_MAX_RESULT_BYTES);
  });
});
