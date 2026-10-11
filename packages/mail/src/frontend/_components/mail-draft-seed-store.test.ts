import { describe, expect, test } from "bun:test";
import type { MailDraftSeed } from "../../contracts";
import { mailDraftSeedKey, readMailDraftSeed, removeMailDraftSeed, storeMailDraftSeed } from "./mail-draft-seed-store";

const mailboxId = "Box001";
const seedId = "20000000-0000-4000-8000-000000000002";

const seed = (createdAt = new Date().toISOString()): MailDraftSeed => ({
  id: seedId,
  mailboxId,
  conversationId: null,
  intent: "new",
  sourceMessageId: null,
  derivedFromMessageId: null,
  derivationKind: null,
  content: {
    signatureTemplateId: "Sign01",
    senderIdentityId: "Send01",
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    body: "",
    format: "markdown",
    priority: "normal",
    requestDeliveryReceipt: false,
    requestReadReceipt: false,
  },
  attachments: [],
  origin: {
    kind: "compose",
    input: {
      senderIdentityId: "Send01",
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      body: "",
      format: "markdown",
      priority: "normal",
      requestDeliveryReceipt: false,
      requestReadReceipt: false,
      conversationId: null,
      intent: "new",
      sourceMessageId: null,
      includeSourceAttachments: false,
    },
  },
  createdAt,
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

describe("mail draft seed storage", () => {
  test("round-trips and removes a valid local compose seed", () => {
    const storage = memoryStorage();
    const value = seed();
    storeMailDraftSeed(storage, value);
    expect(readMailDraftSeed(storage, mailboxId, seedId)).toEqual(value);
    removeMailDraftSeed(storage, mailboxId, seedId);
    expect(storage.getItem(mailDraftSeedKey(mailboxId, seedId))).toBeNull();
  });

  test("removes malformed and expired local seeds", () => {
    const storage = memoryStorage();
    storage.setItem(mailDraftSeedKey(mailboxId, seedId), "{broken");
    expect(readMailDraftSeed(storage, mailboxId, seedId)).toBeNull();
    storeMailDraftSeed(storage, seed("2026-07-26T00:00:00.000Z"));
    expect(readMailDraftSeed(storage, mailboxId, seedId)).toBeNull();
  });
});
