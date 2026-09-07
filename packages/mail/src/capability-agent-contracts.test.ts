import { describe, expect, test } from "bun:test";
import {
  DraftPatchInputSchema,
  MailboxBrowseDataSchema,
  MailboxListDataSchema,
  MessageContentReadInputSchema,
} from "./capability-contracts";

describe("Mail agent contracts", () => {
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
