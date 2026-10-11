import { describe, expect, test } from "bun:test";
import type { SenderIdentity } from "../../contracts";
import { readMailSenderPreference, selectComposeSenderIdentity, writeMailSenderPreference } from "./mail-sender-preference";

const mailboxId = "Box001";

const identity = (id: string, options: { isDefault?: boolean; status?: SenderIdentity["status"] } = {}): SenderIdentity => ({
  id,
  mailboxId,
  label: id,
  displayName: id,
  fromAddress: `${id}@example.com`,
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
  isDefault: options.isDefault ?? false,
  status: options.status ?? "verified",
  statusReason: null,
  pendingVerificationCommandId: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});

const memoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
};

describe("mail sender preference", () => {
  test("round-trips a mailbox-scoped identity without making storage required", () => {
    const storage = memoryStorage();
    writeMailSenderPreference(storage, mailboxId, "Send01");
    expect(readMailSenderPreference(storage, mailboxId)).toBe("Send01");
    expect(readMailSenderPreference(storage, "Box002")).toBeNull();

    const unavailable = {
      ...storage,
      getItem: () => {
        throw new Error("unavailable");
      },
      setItem: () => {
        throw new Error("unavailable");
      },
    };
    expect(() => writeMailSenderPreference(unavailable, mailboxId, "Send02")).not.toThrow();
    expect(readMailSenderPreference(unavailable, mailboxId)).toBeNull();

    storage.setItem("cloud:mail:last-sender:Box001", "00000000-0000-4000-8000-000000000001");
    expect(readMailSenderPreference(storage, mailboxId)).toBeNull();
  });

  test("uses the last verified sender, then the default, then the explicit first fallback", () => {
    const identities = [identity("Send01"), identity("Send02", { isDefault: true }), identity("Send03", { status: "disabled" })];
    expect(selectComposeSenderIdentity(identities, "Send01", true)?.id).toBe("Send01");
    expect(selectComposeSenderIdentity(identities, "Send03", true)?.id).toBe("Send02");
    expect(selectComposeSenderIdentity([identity("Send01"), identity("Send02")], null, false)).toBeNull();
    expect(selectComposeSenderIdentity([identity("Send01"), identity("Send02")], null, true)?.id).toBe("Send01");
  });
});
