import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { type SharedTextSyncEvent, toBase64 } from "@k2b/cloud/shared-text";
import * as Y from "yjs";
import { type DraftEditableContent, draftEditableContentInputSchema } from "../contracts";
import { createDraftDocument, DRAFT_BODY, DRAFT_SUBJECT, readDraftDocument } from "../lib/draft-document";
import { DRAFT_REVISION_OPERATION_ORIGIN, draftRevisionOperationContent, findDraftRevisionOperation } from "./draft-document-operation";

const NOW = Date.UTC(2026, 9, 23, 12);
const actor = { kind: "user" as const, id: "actor-a" };
const content = draftEditableContentInputSchema.parse({ senderIdentityId: "Send01", signatureTemplateId: null, body: "", subject: "" });
const docs: Y.Doc[] = [];
const document = (state: Uint8Array, clientID: number) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  doc.clientID = clientID;
  docs.push(doc);
  return doc;
};
const fixture = (recipients: Partial<Pick<DraftEditableContent, "to" | "cc" | "bcc">> = {}) => {
  spyOn(Date, "now").mockReturnValue(NOW);
  const submitted = { ...content, ...recipients };
  const seed = createDraftDocument(submitted);
  docs.push(seed);
  const base = Y.encodeStateAsUpdate(seed);
  const writer = document(base, 101);
  const vector = Y.encodeStateVector(writer);
  writer.getText(DRAFT_BODY).insert(0, "x");
  writer.getText(DRAFT_SUBJECT).insert(0, "x");
  const update = Y.encodeStateAsUpdate(writer, vector);
  const event = {
    cursor: "receipt-1",
    data: {
      kind: "sync" as const,
      actor,
      originNodeId: DRAFT_REVISION_OPERATION_ORIGIN,
      originPeerId: "1",
      restoreRevision: "1",
      payload: toBase64(update),
    },
  };
  const operation = {
    base,
    content: { ...submitted, body: "x", subject: "x" },
    actor,
    generation: "1",
    expectedRevision: 1,
    deadline: NOW + 10_000,
  };
  return { base, update, event, operation };
};
async function* events(items: { cursor: string; data: SharedTextSyncEvent }[]) {
  yield* items;
}
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
  mock.restore();
});

describe("Mail authenticated revision operation receipts", () => {
  test.each(["committed", "rolled back"])("omitted recipient names reuse the %s receipt without duplicating text", async (status) => {
    const { base, update, event, operation } = fixture({
      to: [{ address: "to@example.test" }],
      cc: [{ address: "cc@example.test" }],
      bcc: [{ address: "bcc@example.test" }],
    });
    const peer = document(base, 202);
    peer.getText(DRAFT_BODY).insert(0, "peer");
    peer.getText(DRAFT_SUBJECT).insert(0, "peer");
    const projection = document(base, 303);
    if (status === "committed") Y.applyUpdate(projection, update);
    Y.applyUpdate(projection, Y.encodeStateAsUpdate(peer));
    for (const recipientName of [undefined, null]) {
      const submitted = {
        ...operation.content,
        to: operation.content.to.map((entry) => ({ ...entry, name: recipientName })),
        cc: operation.content.cc.map((entry) => ({ ...entry, name: recipientName })),
        bcc: operation.content.bcc.map((entry) => ({ ...entry, name: recipientName })),
      };
      const receipt = await findDraftRevisionOperation({ ...operation, content: submitted, events: events([event]) });
      expect(receipt?.update).toEqual(update);
      if (!receipt) throw new Error("Missing omitted-name receipt");
      Y.applyUpdate(projection, receipt.update);
    }
    const projected = readDraftDocument(projection);
    expect(projected.body).toBe("xpeer");
    expect(projected.subject).toBe("xpeer");
    expect(
      await findDraftRevisionOperation({
        ...operation,
        content: { ...operation.content, to: [{ address: "to@example.test", name: "Different" }] },
        events: events([event]),
      }),
    ).toBeNull();
  });

  test("reuses exact insertion identities with a distinct peer on commit and rollback retries", async () => {
    const { base, update, event, operation } = fixture();
    const peer = document(base, 202);
    const vector = Y.encodeStateVector(peer);
    peer.getText(DRAFT_BODY).insert(0, "peer");
    peer.getText(DRAFT_SUBJECT).insert(0, "peer");
    const peerUpdate = Y.encodeStateAsUpdate(peer, vector);
    for (const id of [303, 404]) {
      // One projection is committed, one is reconstructed from the original
      // base as after SQL rollback. Both see the same ordered publication.
      const projection = document(base, id);
      Y.applyUpdate(projection, update);
      Y.applyUpdate(projection, peerUpdate);
      const before = readDraftDocument(projection);
      for (let retry = 0; retry < 2; retry++) {
        const receipt = await findDraftRevisionOperation({ ...operation, events: events([event]) });
        expect(receipt?.update).toEqual(update);
        if (!receipt) throw new Error("Missing receipt");
        Y.applyUpdate(projection, receipt.update);
      }
      expect(readDraftDocument(projection)).toEqual(before);
      expect(before.body.replace("peer", "")).toBe("x");
      expect(before.subject.replace("peer", "")).toBe("x");
    }
  });

  test("matches exact content, actor, generation, base and server provenance without hash/client-ID aliases", async () => {
    const { event, operation } = fixture();
    for (const data of [
      { ...event.data, originNodeId: "browser" },
      { ...event.data, originPeerId: "2" },
      { ...event.data, restoreRevision: "2" },
      { ...event.data, actor: { ...actor, id: "actor-b" } },
      { ...event.data, actor: { kind: "service_account" as const, id: actor.id } },
      { ...event.data, kind: "freeze" as const },
    ])
      expect(await findDraftRevisionOperation({ ...operation, events: events([{ ...event, data }]) })).toBeNull();
    expect(
      await findDraftRevisionOperation({ ...operation, content: { ...operation.content, subject: "different" }, events: events([event]) }),
    ).toBeNull();
    expect((await findDraftRevisionOperation({ ...operation, events: events([event]) }))?.cursor).toBe(event.cursor);
  });

  test("incomplete history, corrupt receipts, expired budgets and cancellation never mean a new operation", async () => {
    const { event, operation } = fixture();
    async function* gap() {
      throw new Error("Retained history gap");
    }
    await expect(findDraftRevisionOperation({ ...operation, events: gap() })).rejects.toThrow("gap");
    await expect(
      findDraftRevisionOperation({ ...operation, events: events([{ ...event, data: { ...event.data, payload: "invalid" } }]) }),
    ).rejects.toThrow();
    await expect(findDraftRevisionOperation({ ...operation, deadline: NOW, events: events([]) })).rejects.toThrow("deadline");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(findDraftRevisionOperation({ ...operation, signal: controller.signal, events: events([]) })).rejects.toThrow("cancelled");
  });

  test("omitted signature is normalized against the exact base", () => {
    const { base, operation } = fixture();
    expect(draftRevisionOperationContent(base, { ...operation.content, signatureTemplateId: undefined })).toEqual(operation.content);
  });
});
