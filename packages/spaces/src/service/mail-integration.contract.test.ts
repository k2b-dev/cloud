import { expect, mock, test } from "bun:test";
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
mock.module("@valentinkolb/cloud/capabilities/server", () => ({
  getCapabilityCatalogApp: async () => ({ ok: false }),
  invokeCapabilityWithDataSchema: async (call: { capabilityId: string; input: unknown }, schema: z.ZodType) => {
    calls.push(call);
    const raw =
      call.capabilityId === "mailbox.list" ? mailbox : call.capabilityId === "mailbox.identity.list" ? identities : { id: "Draft1" };
    const parsed = schema.safeParse(raw);
    return parsed.success
      ? { ok: true, data: { data: parsed.data } }
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
