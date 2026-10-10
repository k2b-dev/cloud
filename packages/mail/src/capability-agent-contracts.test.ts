import { describe, expect, test } from "bun:test";
import {
  ConversationKeepDataSchema,
  ConversationKeepInputSchema,
  ConversationKeepReleaseDataSchema,
  ConversationListInputSchema,
  DraftPatchInputSchema,
  MailboxBrowseDataSchema,
  MailboxListDataSchema,
  MessageContentReadInputSchema,
} from "./capability-contracts";

describe("Mail agent contracts", () => {
  test("keep and release carry exact conversation identities without incidental revision state", () => {
    const input = { mailboxId: "MbA123", conversationId: "CvB456" };
    expect(ConversationKeepInputSchema.parse(input)).toEqual(input);
    expect(ConversationListInputSchema.parse({ mailboxId: "MbA123", view: "kept" }).view).toBe("kept");
    expect(
      ConversationKeepDataSchema.safeParse({
        conversationId: input.conversationId,
        keptAt: "2026-10-09T12:00:00Z",
        keptBy: { kind: "system", id: null, displayName: "System", avatarHash: null },
      }).success,
    ).toBeTrue();
    expect(ConversationKeepReleaseDataSchema.parse({ conversationId: input.conversationId, released: true }).released).toBeTrue();
  });
  test("patch never supplies defaults for omitted draft fields", () => {
    const value = { mailboxId: "MbA123", draftId: "DrG789", expectedRevision: 3, patch: { subject: "Updated" } };
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
