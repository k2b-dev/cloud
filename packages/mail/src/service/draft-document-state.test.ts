import { expect, test } from "bun:test";
import * as Y from "yjs";
import { draftEditableContentInputSchema } from "../contracts";
import { createDraftDocument, DRAFT_BODY } from "../lib/draft-document";
import { sameDraftDocumentState } from "./draft-document-state";

const content = draftEditableContentInputSchema.parse({
  senderIdentityId: "Send01",
  to: [{ address: "ada@example.test" }],
  subject: "Review",
  body: "Exact text",
});

test("send boundaries compare causal state, deletions and the complete projected content", () => {
  const original = createDraftDocument(content);
  const peer = new Y.Doc();
  const differentHeader = createDraftDocument({ ...content, subject: "Revise" });
  try {
    const state = Y.encodeStateAsUpdate(original);
    Y.applyUpdate(peer, state);
    expect(sameDraftDocumentState(state, Y.encodeStateAsUpdate(peer))).toBe(true);
    // Seeding uses deterministic IDs: equal clocks alone cannot prove equal content.
    expect(Y.equalSnapshots(Y.snapshot(original), Y.snapshot(differentHeader))).toBe(true);
    expect(sameDraftDocumentState(state, Y.encodeStateAsUpdate(differentHeader))).toBe(false);
    peer.getText(DRAFT_BODY).delete(0, 1);
    expect(sameDraftDocumentState(state, Y.encodeStateAsUpdate(peer))).toBe(false);
    peer.getText(DRAFT_BODY).insert(0, "E");
    // Even an equal rendered body must retain the exact accepted causal history.
    expect(peer.getText(DRAFT_BODY).toString()).toBe(content.body);
    expect(sameDraftDocumentState(state, Y.encodeStateAsUpdate(peer))).toBe(false);
    expect(sameDraftDocumentState(null, state)).toBe(false);
    expect(sameDraftDocumentState(state, new Uint8Array([255]))).toBe(false);
  } finally {
    original.destroy();
    peer.destroy();
    differentHeader.destroy();
  }
});
