import { describe, expect, spyOn, test } from "bun:test";
import * as Y from "yjs";
import { createDraftDocument, DRAFT_BODY, readDraftDocument, writeLocalDraftHeaders } from "./draft-document";
import { draftSnapshotCovers, spliceDraftText } from "./draft-document-client";

const content = {
  senderIdentityId: "Send01",
  signatureTemplateId: null,
  to: [{ name: null, address: "ada@example.test" }],
  cc: [],
  bcc: [],
  subject: "Offer",
  body: "Hello 🌍\n\n| Item | Cost |\n| --- | --- |\n| Pen | 4 |",
  format: "markdown" as const,
  priority: "normal" as const,
  requestDeliveryReceipt: false,
  requestReadReceipt: false,
};

describe("Mail shared client recovery coverage", () => {
  test("a transport echo and a state-vector match do not cover an unpersisted deletion", () => {
    const local = createDraftDocument(content);
    const durable = Y.encodeStateAsUpdate(local);
    const vector = Y.encodeStateVector(local);
    local.getText(DRAFT_BODY).delete(0, 5);
    expect(Y.encodeStateVector(local)).toEqual(vector);
    expect(draftSnapshotCovers(durable, Y.encodeStateAsUpdate(local))).toBe(false);
    expect(draftSnapshotCovers(Y.encodeStateAsUpdate(local), Y.encodeStateAsUpdate(local))).toBe(true);
    local.destroy();
  });
  test("coverage rejects a binary state whose dependencies are unresolved", () => {
    const local = createDraftDocument(content);
    const vector = Y.encodeStateVector(local);
    local.getText(DRAFT_BODY).insert(2, "device text");
    const delta = Y.encodeStateAsUpdate(local, vector);
    expect(draftSnapshotCovers(delta, delta)).toBe(false);
    local.destroy();
  });
  test("an older durable snapshot cannot clear a newer header edit", () => {
    const local = createDraftDocument(content);
    const durable = Y.encodeStateAsUpdate(local);
    writeLocalDraftHeaders(local, content, { ...content, bcc: [{ name: null, address: "b@example.test" }] });
    expect(draftSnapshotCovers(durable, Y.encodeStateAsUpdate(local))).toBe(false);
    local.destroy();
  });
});

describe("external body changes keep Yjs identities", () => {
  test("a template splice merges with a concurrent peer insertion instead of replacing the body", () => {
    const local = createDraftDocument(content),
      peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(local));
    const base = Y.encodeStateVector(local);
    spliceDraftText(local.getText(DRAFT_BODY), content.body.replace("Hello", "Dear Ada"));
    peer.getText(DRAFT_BODY).insert(peer.getText(DRAFT_BODY).length, "\nPeer footer");
    const update = Y.encodeStateAsUpdate(peer, base);
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(local, base));
    Y.applyUpdate(local, update);
    expect(readDraftDocument(local).body).toBe(content.body.replace("Hello", "Dear Ada") + "\nPeer footer");
    expect(readDraftDocument(peer)).toEqual(readDraftDocument(local));
    local.destroy();
    peer.destroy();
  });
  test("changing one emoji preserves valid UTF-16 on both replicas", () => {
    const local = createDraftDocument(content),
      peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(local));
    const vector = Y.encodeStateVector(local);
    spliceDraftText(local.getText(DRAFT_BODY), content.body.replace("🌍", "🌎"));
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(local, vector));
    expect(readDraftDocument(peer).body).toBe(content.body.replace("🌍", "🌎"));
    local.destroy();
    peer.destroy();
  });
});

test.each([1, 1000])("external body replacement preserves peer text at its original edge (peer %s)", (peerId) => {
  const seeded = createDraftDocument({ ...content, body: "Project notes" });
  const state = Y.encodeStateAsUpdate(seeded);
  const own = new Y.Doc(),
    peer = new Y.Doc();
  own.clientID = 100;
  peer.clientID = peerId;
  Y.applyUpdate(own, state);
  Y.applyUpdate(peer, state);
  try {
    peer.getText(DRAFT_BODY).insert(7, " peer");
    own.transact(() => spliceDraftText(own.getText(DRAFT_BODY), "PROJECT notes"));
    const ownUpdate = Y.encodeStateAsUpdate(own);
    Y.applyUpdate(own, Y.encodeStateAsUpdate(peer));
    Y.applyUpdate(peer, ownUpdate);
    expect(readDraftDocument(own).body).toBe("PROJECT peer notes");
    expect(readDraftDocument(peer).body).toBe("PROJECT peer notes");
  } finally {
    seeded.destroy();
    own.destroy();
    peer.destroy();
  }
});

for (const peerId of [1, 1000]) {
  for (const peerFirst of [false, true]) {
    test(`disjoint external body changes retain a peer deletion (peer ${peerId}, peer first ${peerFirst})`, () => {
      const seeded = createDraftDocument({ ...content, body: "Alpha middle Omega" });
      const own = new Y.Doc(),
        peer = new Y.Doc();
      own.clientID = 100;
      peer.clientID = peerId;
      const state = Y.encodeStateAsUpdate(seeded);
      Y.applyUpdate(own, state);
      Y.applyUpdate(peer, state);
      try {
        peer.getText(DRAFT_BODY).delete(6, 7);
        own.transact(() => spliceDraftText(own.getText(DRAFT_BODY), "ALPHA middle OMEGA"));
        const ownUpdate = Y.encodeStateAsUpdate(own),
          peerUpdate = Y.encodeStateAsUpdate(peer);
        const merged = new Y.Doc();
        try {
          Y.applyUpdate(merged, peerFirst ? peerUpdate : ownUpdate);
          Y.applyUpdate(merged, peerFirst ? ownUpdate : peerUpdate);
          expect(readDraftDocument(merged).body).toBe("ALPHA OMEGA");
        } finally {
          merged.destroy();
        }
      } finally {
        seeded.destroy();
        own.destroy();
        peer.destroy();
      }
    });
  }
}

test("an exhausted external diff budget leaves every original text identity untouched", () => {
  const doc = createDraftDocument(content);
  const original = Y.encodeStateAsUpdate(doc);
  const clock = spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(1000);
  try {
    expect(() => spliceDraftText(doc.getText(DRAFT_BODY), "Entirely different body")).toThrow("editing budget");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(original);
  } finally {
    clock.mockRestore();
    doc.destroy();
  }
});
