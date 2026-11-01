import { describe, expect, test } from "bun:test";
import { crypto } from "@k2b/stdlib";
import type { DraftEditableContent } from "../../contracts";
import { advanceMailDraftJournalAfterSave, readMailDraftJournal, serializeMailDraftJournal } from "./mail-draft-journal";

const content = (body: string): DraftEditableContent => ({
  senderIdentityId: "Send01",
  to: [],
  cc: [],
  bcc: [],
  subject: "Subject",
  body,
  format: "plain",
  priority: "normal",
  requestDeliveryReceipt: false,
  requestReadReceipt: false,
});

const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
};

describe("mail draft journals", () => {
  test("advances newer local changes to the saved server revision", () => {
    const target = storage();
    target.setItem("draft", JSON.stringify({ revision: 4, content: content("newer local edit") }));

    expect(
      advanceMailDraftJournalAfterSave({
        storage: target,
        key: "draft",
        revision: 5,
        savedContent: content("submitted save"),
      }),
    ).toBe(true);
    expect(readMailDraftJournal(target, "draft")).toEqual({
      revision: 5,
      content: content("newer local edit"),
      confirmedContent: content("submitted save"),
    });
  });

  test("keeps a compact confirmed digest beside newer local input", async () => {
    const target = storage();
    const savedContent = content("submitted save");
    const digest = await crypto.common.hash(JSON.stringify({ ...savedContent, signatureTemplateId: null }));
    target.setItem("draft", JSON.stringify({ revision: 4, content: content("newer local edit") }));
    advanceMailDraftJournalAfterSave({ storage: target, key: "draft", revision: 5, savedContent, confirmedDigest: digest });
    expect(readMailDraftJournal(target, "draft")).toEqual({ revision: 5, content: content("newer local edit"), confirmedDigest: digest });
    expect(target.getItem("draft")).not.toContain("submitted save");
  });

  test("stores matching pending input once and reconstructs its exact replay", () => {
    const target = storage();
    const same = content("pending body");
    const journal = { revision: 3, content: same, pendingSave: { revision: 3, content: same } };
    const raw = serializeMailDraftJournal(journal);
    expect(raw.match(/pending body/g)).toHaveLength(1);
    target.setItem("draft", raw);
    expect(readMailDraftJournal(target, "draft")).toEqual(journal);
    const newer = { ...journal, content: content("later typing") };
    target.setItem("draft", serializeMailDraftJournal(newer));
    expect(readMailDraftJournal(target, "draft")).toEqual(newer);
  });

  test("removes a journal once its exact content is saved", () => {
    const target = storage();
    target.setItem("draft", JSON.stringify({ revision: 4, content: content("saved") }));

    expect(
      advanceMailDraftJournalAfterSave({
        storage: target,
        key: "draft",
        revision: 5,
        savedContent: content("saved"),
      }),
    ).toBe(false);
    expect(target.getItem("draft")).toBeNull();
  });

  test("retains a newer signature choice during a save and removes it once saved", () => {
    const target = storage();
    const savedContent = { ...content("same body"), signatureTemplateId: "Sign01" };
    const current = { ...savedContent, signatureTemplateId: null };
    target.setItem("draft", JSON.stringify({ revision: 4, content: current }));
    expect(advanceMailDraftJournalAfterSave({ storage: target, key: "draft", revision: 5, savedContent })).toBe(true);
    expect(readMailDraftJournal(target, "draft")).toEqual({ revision: 5, content: current, confirmedContent: savedContent });
    expect(advanceMailDraftJournalAfterSave({ storage: target, key: "draft", revision: 6, savedContent: current })).toBe(false);
  });

  test("treats a legacy missing signature as an explicit No signature choice", () => {
    const target = storage();
    const savedContent = { ...content("same body"), signatureTemplateId: null };
    target.setItem("draft", JSON.stringify({ revision: 4, content: content("same body") }));
    expect(advanceMailDraftJournalAfterSave({ storage: target, key: "draft", revision: 5, savedContent })).toBe(false);
  });

  test("removes malformed journals instead of exposing partial content", () => {
    const target = storage();
    target.setItem("draft", JSON.stringify({ revision: 1, content: { body: "partial" } }));
    expect(readMailDraftJournal(target, "draft")).toBeNull();
    expect(target.getItem("draft")).toBeNull();
  });
});
