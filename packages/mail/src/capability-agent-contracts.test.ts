import { describe, expect, test } from "bun:test";
import {
  ConversationAssignInputSchema,
  ConversationKeepDataSchema,
  ConversationKeepInputSchema,
  ConversationKeepReleaseDataSchema,
  ConversationKeepReleaseInputSchema,
  ConversationListInputSchema,
  ConversationMarkInputSchema,
  ConversationMoveInputSchema,
  ConversationSearchInputSchema,
  ConversationStatusSetBatchInputSchema,
  ConversationStatusSetInputSchema,
  ConversationStatusUpdateBatchInputSchema,
  ConversationStatusUpdateInputSchema,
  ConversationSummaryWriteInputSchema,
  DraftPatchInputSchema,
  MailboxBrowseDataSchema,
  MailboxListDataSchema,
  MessageContentReadInputSchema,
} from "./capability-contracts";

describe("Mail agent contracts", () => {
  test("keep and release carry exact conversation identities without incidental revision state", () => {
    const input = { conversationId: "CvB456" };
    expect(ConversationKeepInputSchema.parse(input)).toEqual(input);
    expect(ConversationKeepReleaseInputSchema.parse({ ...input, reason: "  Policy reviewed  " })).toEqual({
      ...input,
      reason: "Policy reviewed",
    });
    expect(ConversationKeepReleaseInputSchema.safeParse({ ...input, reason: "x".repeat(501) }).success).toBeFalse();

    expect(ConversationListInputSchema.parse({ view: "kept" }).view).toBe("kept");
    expect(
      ConversationKeepDataSchema.safeParse({
        conversationId: input.conversationId,
        canLift: false,
        keptAt: "2026-10-09T12:00:00Z",
        keptBy: { kind: "system", id: null, displayName: "System", avatarHash: null },
      }).success,
    ).toBeTrue();
    expect(ConversationKeepReleaseDataSchema.parse({ conversationId: input.conversationId, released: true }).released).toBeTrue();
  });
  test("patch never supplies defaults for omitted draft fields", () => {
    const value = { draftId: "DrG789", expectedRevision: 3, patch: { subject: "Updated" } };
    expect(DraftPatchInputSchema.parse(value)).toEqual(value);
    expect(DraftPatchInputSchema.parse({ ...value, patch: { to: [] } }).patch).toEqual({ to: [] });
    expect(DraftPatchInputSchema.safeParse({ ...value, patch: {} }).success).toBeFalse();
    expect(DraftPatchInputSchema.safeParse({ ...value, expectedRevision: undefined }).success).toBeFalse();
    expect(DraftPatchInputSchema.safeParse({ ...value, patch: { unknown: true } }).success).toBeFalse();
  });
  test("keeps mailbox.list compatible while compact browsing excludes administrative fields", () => {
    const base = {
      ref: { type: "mail.mailbox", id: "MbA123" },
      title: "Support",
      permission: "write",
      accessScope: "mailbox",
      links: [{ rel: "open", href: "/app/mail/MbA123" }],
    };
    expect(MailboxListDataSchema.safeParse([{ ...base, health: "active", syncEnabled: true }]).success).toBeTrue();
    expect(MailboxBrowseDataSchema.safeParse([{ ...base, unreadCount: 2, needsActionCount: 4 }]).success).toBeTrue();
    expect(MailboxBrowseDataSchema.safeParse([{ ...base, unreadCount: 2, needsActionCount: 4, createdAt: "extra" }]).success).toBeFalse();
  });
  test("message text defaults to a small explicit byte window", () => {
    expect(MessageContentReadInputSchema.parse({ id: "MsH890" })).toEqual({ id: "MsH890", offset: 0, length: 16384 });
    expect(MessageContentReadInputSchema.safeParse({ id: "MsH890", offset: -1 }).success).toBeFalse();
    expect(MessageContentReadInputSchema.safeParse({ id: "MsH890", length: 65537 }).success).toBeFalse();
  });
});

test("agent flag searches preserve their folder scope through Boolean expressions", () => {
  for (const type of ["unread", "flagged"] as const) {
    const expression = { type: "not" as const, expression: { type, folderId: "Fold01" } };
    expect(ConversationSearchInputSchema.parse({ expression }).expression).toEqual(expression);
    expect(
      ConversationSearchInputSchema.safeParse({
        expression: { type, folderId: "11111111-1111-4111-8111-111111111111" },
      }).success,
    ).toBe(false);
  }
});

describe("Mail unattended mutation contracts", () => {
  const target = { conversationId: "CvB456", sourceFolderId: "FdC345", messageId: "MsH890" };
  test("move and mark can explicitly target one message", () => {
    expect(ConversationMarkInputSchema.parse({ target, read: true }).target).toEqual(target);
    expect(ConversationMoveInputSchema.parse({ target, destination: { kind: "role", role: "archive" } }).target).toEqual(target);
  });
  test("published update schemas retain done and open only", () => {
    for (const status of ["waiting", "needs_action"]) {
      expect(ConversationStatusUpdateInputSchema.safeParse({ conversationId: "CvB456", expectedRevision: 3, status }).success).toBeFalse();
      expect(ConversationStatusUpdateBatchInputSchema.safeParse({ conversationIds: ["CvB456"], status }).success).toBeFalse();
    }
  });
  test("status accepts domain states and preserves explicit revisions", () => {
    for (const status of ["needs_action", "waiting", "done", "open"] as const) {
      expect(ConversationStatusSetInputSchema.parse({ conversationId: "CvB456", expectedRevision: 3, status }).status).toBe(status);
      expect(
        ConversationStatusSetBatchInputSchema.parse({
          conversationIds: ["CvB456"],
          expectedRevisions: { CvB456: 3 },
          status,
        }).expectedRevisions,
      ).toEqual({ CvB456: 3 });
    }
  });
  test("unassigned-only assignment requires a revision and a nonempty add", () => {
    const input = {
      conversationId: "CvB456",
      assigneeUserIds: ["11111111-1111-4111-8111-111111111111"],
      mode: "add" as const,
      onlyIfUnassigned: true,
      expectedRevision: 3,
    };
    expect(ConversationAssignInputSchema.parse(input)).toEqual(input);
    expect(ConversationAssignInputSchema.safeParse({ ...input, expectedRevision: undefined }).success).toBeFalse();
    expect(ConversationAssignInputSchema.safeParse({ ...input, mode: "remove" }).success).toBeFalse();
    expect(ConversationAssignInputSchema.safeParse({ ...input, assigneeUserIds: [] }).success).toBeFalse();
  });
  test("automated summaries require both source and text revisions", () => {
    const input = {
      conversationId: "CvB456",
      expectedRevision: 3,
      expectedSummaryRevision: 2,
      summary: "  Summary  ",
    };
    expect(ConversationSummaryWriteInputSchema.parse(input).summary).toBe("Summary");
    expect(ConversationSummaryWriteInputSchema.safeParse({ ...input, expectedRevision: undefined }).success).toBeFalse();
    expect(ConversationSummaryWriteInputSchema.safeParse({ ...input, expectedSummaryRevision: undefined }).success).toBeFalse();
  });
});

test("provider answered and draft flags require an exact-message target", () => {
  const target = { conversationId: "CvB456", sourceFolderId: "FdC345" };
  expect(ConversationMarkInputSchema.safeParse({ target, answered: true }).success).toBeFalse();
  expect(ConversationMarkInputSchema.parse({ target: { ...target, messageId: "MsH890" }, answered: true, draft: false })).toMatchObject({
    answered: true,
    draft: false,
  });
});
