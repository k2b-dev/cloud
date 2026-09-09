import { beforeEach, expect, mock, test } from "bun:test";
import type { z } from "zod";
import { MailboxListDataSchema, SenderIdentityListDataSchema } from "../../../mail/src/capability-contracts";

const mailbox = MailboxListDataSchema.parse([
  {
    ref: { type: "mail.mailbox", id: "Mail01" },
    title: "Team",
    links: [{ rel: "open", href: "/app/mail/Mail01" }],
    permission: "write",
    health: "active",
    syncEnabled: true,
  },
]);
const identities = SenderIdentityListDataSchema.parse([
  {
    ref: { type: "mail.sender-identity", id: "Ident1" },
    label: "Team sender",
    displayName: "Team",
    fromAddress: "team@example.com",
    replyTo: null,
    defaultCc: [],
    defaultBcc: [],
    recipientsTruncated: false,
    defaultFormat: "plain",
    defaultPriority: "normal",
    defaultDeliveryReceipt: false,
    defaultReadReceipt: false,
    isDefault: true,
    status: "verified",
  },
]);
const calls: Array<{ capabilityId: string; input: unknown }> = [];
let mailboxPages: Array<{ data: unknown; page?: { hasMore: boolean; nextCursor?: string } }> | undefined;
let identityPage: { hasMore: boolean; nextCursor?: string } | undefined;
let identityPages: Array<{ hasMore: boolean; nextCursor?: string }> | undefined;
beforeEach(() => {
  calls.length = 0;
  mailboxPages = undefined;
  identityPage = undefined;
  identityPages = undefined;
});
mock.module("@k2b/cloud/capabilities/server", () => ({
  getCapabilityCatalogApp: async () => ({ ok: false }),
  invokeCapabilityWithDataSchema: async (call: { capabilityId: string; input: unknown }, schema: z.ZodType) => {
    calls.push(call);
    const mailboxPage = call.capabilityId === "mailbox.list" ? mailboxPages?.shift() : undefined;
    const raw =
      call.capabilityId === "mailbox.list"
        ? (mailboxPage?.data ?? mailbox)
        : call.capabilityId === "mailbox.identity.list"
          ? identities
          : { id: "Draft1" };
    const parsed = schema.safeParse(raw);
    return parsed.success
      ? {
          ok: true,
          data: {
            data: parsed.data,
            page: call.capabilityId === "mailbox.list" ? mailboxPage?.page : (identityPages?.shift() ?? identityPage),
          },
        }
      : { ok: false, error: { code: "INVALID_RESULT", message: "Invalid Mail response", status: 502 } };
  },
}));
const { listInvitationMailboxes, createInvitationDraft } = await import("./mail-integration");

test("reads current Mail resource refs and projects invitation sender IDs", async () => {
  const result = await listInvitationMailboxes({});
  expect(result).toEqual({
    ok: true,
    data: [
      {
        id: "Mail01",
        name: "Team",
        identities: [{ id: "Ident1", label: "Team sender", from: { name: "Team", address: "team@example.com" }, isDefault: true }],
      },
    ],
  });
  expect(calls.at(-1)?.input).toEqual({ mailboxId: "Mail01", limit: 50 });
});

test("resolves the verified sender ref when preparing a draft", async () => {
  const result = await createInvitationDraft(
    {
      mailboxId: "Mail01",
      senderIdentityId: "Ident1",
      idempotencyKey: crypto.randomUUID(),
      to: [{ name: null, address: "guest@example.com" }],
      subject: "Invitation",
      body: "Join us",
      calendar: "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR",
    },
    {},
  );
  expect(result).toEqual({ ok: true, data: { mailboxId: "Mail01", draftId: "Draft1" } });
  expect(calls.at(-1)?.capabilityId).toBe("draft.create");
});

test("includes writable mailboxes from the next page", async () => {
  mailboxPages = [
    { data: mailbox, page: { hasMore: true, nextCursor: "page2" } },
    { data: [{ ...mailbox[0], ref: { type: "mail.mailbox", id: "Mail02" }, title: "Other" }], page: { hasMore: false } },
  ];
  const result = await listInvitationMailboxes({});
  expect(result.ok && result.data.map((item) => item.id)).toEqual(["Mail01", "Mail02"]);
  expect(calls.filter((call) => call.capabilityId === "mailbox.list").map((call) => call.input)).toEqual([
    { minimumPermission: "write", limit: 100 },
    { minimumPermission: "write", limit: 100, cursor: "page2" },
  ]);
});

test("fails explicitly on incomplete mailbox or sender lists", async () => {
  mailboxPages = [{ data: mailbox, page: { hasMore: true } }];
  expect(await listInvitationMailboxes({})).toMatchObject({ ok: false, code: "INVALID_APP_RESPONSE" });
  mailboxPages = [
    { data: Array.from({ length: 100 }, () => mailbox[0]), page: { hasMore: true, nextCursor: "page2" } },
    { data: Array.from({ length: 100 }, () => mailbox[0]), page: { hasMore: true, nextCursor: "page3" } },
  ];
  expect(await listInvitationMailboxes({})).toMatchObject({ ok: false, code: "RESULT_TOO_LARGE" });
  mailboxPages = undefined;
  identityPage = { hasMore: true, nextCursor: "repeated" };
  expect(await listInvitationMailboxes({})).toMatchObject({ ok: false, code: "INVALID_APP_RESPONSE" });
});

test("continues beyond two short mailbox and identity pages", async () => {
  mailboxPages = Array.from({ length: 3 }, (_, index) => ({
    data: [{ ...mailbox[0], ref: { type: "mail.mailbox", id: `Mail0${index + 1}` } }],
    page: { hasMore: index < 2, nextCursor: `page${index + 1}` },
  }));
  const mailboxResult = await listInvitationMailboxes({});
  expect(mailboxResult.ok && mailboxResult.data.map((item) => item.id)).toEqual(["Mail01", "Mail02", "Mail03"]);
  mailboxPages = undefined;
  identityPages = [{ hasMore: true, nextCursor: "identity2" }, { hasMore: true, nextCursor: "identity3" }, { hasMore: false }];
  const identityResult = await listInvitationMailboxes({});
  expect(identityResult.ok && identityResult.data[0]?.identities.length).toBe(3);
});
