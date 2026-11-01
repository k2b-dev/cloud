import { expect, test } from "bun:test";
import type { DraftEditableContent } from "../../contracts";
import { confirmSharedDraftRecipients } from "./mail-draft-document-confirmation";

const base: DraftEditableContent = {
  senderIdentityId: "Send01",
  signatureTemplateId: null,
  to: [{ name: null, address: "ada@example.test" }],
  cc: [],
  bcc: [],
  subject: "Offer",
  body: "Text",
  format: "markdown",
  priority: "normal",
  requestDeliveryReceipt: false,
  requestReadReceipt: false,
};
test("a remote sender/recipient change while the dialog is open requires a fresh confirmation", async () => {
  let content = base,
    changed = true,
    confirmations = 0;
  const inventories: DraftEditableContent[] = [];
  expect(
    await confirmSharedDraftRecipients({
      changed: () => changed,
      content: () => content,
      signal: new AbortController().signal,
      confirm: async (inventory) => {
        inventories.push(inventory);
        confirmations++;
        if (confirmations === 1) content = { ...base, senderIdentityId: "Send02", to: [], bcc: base.to };
        return true;
      },
      accepted: () => {
        changed = false;
      },
    }),
  ).toBe(true);
  expect(inventories).toHaveLength(2);
  expect(inventories[1]).toMatchObject({ senderIdentityId: "Send02", to: [], bcc: base.to });
});
test("cancellation never acknowledges a remote recipient inventory", async () => {
  let acknowledged = false;
  expect(
    await confirmSharedDraftRecipients({
      changed: () => true,
      content: () => base,
      signal: new AbortController().signal,
      confirm: async () => false,
      accepted: () => {
        acknowledged = true;
      },
    }),
  ).toBe(false);
  expect(acknowledged).toBe(false);
});
test("a cancelled send cannot acknowledge a dialog that resolves later", async () => {
  const controller = new AbortController();
  let acknowledged = false;
  await expect(
    confirmSharedDraftRecipients({
      changed: () => true,
      content: () => base,
      signal: controller.signal,
      confirm: async () => {
        controller.abort(new Error("cancelled"));
        return true;
      },
      accepted: () => {
        acknowledged = true;
      },
    }),
  ).rejects.toThrow("cancelled");
  expect(acknowledged).toBe(false);
});
