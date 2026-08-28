import { describe, expect, test } from "bun:test";
import type { SenderIdentity } from "../../contracts";
import type { MessageDetail } from "../../service/messages";
import { deriveReplyIdentityId, deriveReplyRecipients } from "./mail-compose-derivation";

const identity = {
  id: "00000000-0000-4000-8000-000000000001",
  mailboxId: "00000000-0000-4000-8000-000000000002",
  label: "Team",
  displayName: "Team",
  fromAddress: "team@example.com",
  replyTo: null,
  defaultCc: [],
  defaultBcc: [],
  defaultFormat: "markdown",
  defaultPriority: "normal",
  defaultDeliveryReceipt: false,
  defaultReadReceipt: false,
  vcard: null,
  envelopeSender: null,
  defaultSignatureTemplateId: null,
  transport: {
    mode: "mailbox",
    host: null,
    port: null,
    tlsMode: null,
    username: null,
    secret: { kind: null, isSet: false },
    revision: 0,
    status: "active",
    capabilities: { dsn: false, size: false, maxMessageBytes: null },
    lastVerifiedAt: null,
    lastError: null,
  },
  authenticationPolicy: { automation: "mailbox" },
  sentFolderId: null,
  draftsFolderId: null,
  isDefault: true,
  status: "verified",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies SenderIdentity;

const message = (overrides: Partial<MessageDetail> = {}): MessageDetail => ({
  id: "00000000-0000-4000-8000-000000000003",
  subject: "Question",
  messageId: "message@example.com",
  internalDate: "2026-01-01T00:00:00.000Z",
  sentAt: null,
  from: [{ name: "Sender", address: "sender@example.com" }],
  replyTo: [],
  to: [{ name: "Team", address: "team@example.com" }],
  cc: [],
  flags: [],
  hydrationStatus: "body",
  remoteAvailable: true,
  folderId: null,
  contentType: "text/plain",
  sizeBytes: 8,
  plainText: "Question",
  sanitizedHtml: null,
  forwardText: "Question",
  selectedHeaders: {},
  sourceAvailable: false,
  mailingList: null,
  keywords: [],
  remoteContent: {
    imageIds: [],
    allowedByRule: false,
    sender: null,
    domain: null,
  },
  delivery: null,
  attachments: [],
  ...overrides,
  preview: overrides.preview ?? null,
  hasAttachments: overrides.hasAttachments ?? false,
});

describe("deriveReplyRecipients", () => {
  test("uses Reply-To for a reply", () => {
    const recipients = deriveReplyRecipients(message({ replyTo: [{ name: "Support queue", address: "support@example.com" }] }), "reply", [
      identity,
    ]);
    expect(recipients).toEqual({ to: ["support@example.com"], cc: [] });
  });

  test("keeps visible Cc recipients for reply all and excludes mailbox identities", () => {
    const recipients = deriveReplyRecipients(
      message({
        replyTo: [{ name: null, address: "list@example.com" }],
        to: [
          { name: "Team", address: "TEAM@example.com" },
          { name: "Manager", address: "manager@example.com" },
        ],
        cc: [
          { name: "Stakeholder", address: "stakeholder@example.com" },
          { name: "Manager duplicate", address: "MANAGER@example.com" },
        ],
      }),
      "reply_all",
      [identity],
    );
    expect(recipients).toEqual({
      to: ["list@example.com"],
      cc: ["manager@example.com", "stakeholder@example.com"],
    });
  });

  test("replies to original recipients when the source was sent by this mailbox", () => {
    const recipients = deriveReplyRecipients(
      message({
        from: [{ name: "Team", address: "team@example.com" }],
        to: [{ name: "Customer", address: "customer@example.com" }],
        cc: [{ name: "Manager", address: "manager@example.com" }],
      }),
      "reply",
      [identity],
    );
    expect(recipients).toEqual({ to: ["customer@example.com"], cc: [] });
  });

  test("keeps original Cc recipients separate when replying all to a sent message", () => {
    const recipients = deriveReplyRecipients(
      message({
        from: [{ name: "Team", address: "team@example.com" }],
        to: [{ name: "Customer", address: "customer@example.com" }],
        cc: [{ name: "Manager", address: "manager@example.com" }],
      }),
      "reply_all",
      [identity],
    );
    expect(recipients).toEqual({ to: ["customer@example.com"], cc: ["manager@example.com"] });
  });
});

describe("deriveReplyIdentityId", () => {
  test("selects the identity that received the source message", () => {
    const alternate = {
      ...identity,
      id: "00000000-0000-4000-8000-000000000004",
      label: "Support",
      fromAddress: "support@example.com",
      isDefault: false,
    };
    expect(deriveReplyIdentityId(message({ to: [{ name: "Support", address: "support@example.com" }] }), [identity, alternate])).toBe(
      alternate.id,
    );
  });

  test("requires an explicit choice when duplicate addresses are ambiguous", () => {
    const duplicate = {
      ...identity,
      id: "00000000-0000-4000-8000-000000000005",
      label: "Business",
      isDefault: false,
    };
    expect(
      deriveReplyIdentityId(message({ to: [{ name: "Team", address: "team@example.com" }] }), [
        { ...identity, isDefault: false },
        duplicate,
      ]),
    ).toBeNull();
  });
});
