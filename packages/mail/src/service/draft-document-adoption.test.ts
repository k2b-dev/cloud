import { describe, expect, test } from "bun:test";
import type { SharedTextSyncEvent } from "@k2b/cloud/shared-text";
import * as Y from "yjs";
import type { DraftEditableContent } from "../contracts";
import { draftAdoptionMessages } from "../draft-adoption-messages";
import { createDraftDocument, createDraftRevisionUpdate } from "../lib/draft-document";
import { hasHumanDraftDocumentEdit } from "./draft-document-adoption";
import { localizeMailError } from "./error-messages";

const content: DraftEditableContent = {
  senderIdentityId: "Sender",
  signatureTemplateId: null,
  to: [{ address: "customer@example.test" }],
  cc: [],
  bcc: [],
  subject: "Question",
  body: "Suggestion",
  format: "plain",
  priority: "normal",
  requestDeliveryReceipt: false,
  requestReadReceipt: false,
};
const event = (update: Uint8Array, kind: "user" | "service_account", generation = "1"): SharedTextSyncEvent => ({
  kind: "sync",
  payload: Buffer.from(update).toString("base64"),
  actor: { kind, id: "author" },
  restoreRevision: generation,
  originNodeId: "test",
  originPeerId: null,
});
const events = async function* (...data: SharedTextSyncEvent[]) {
  for (const value of data) yield { data: value };
};
const seeded = () => {
  const doc = createDraftDocument(content);
  try {
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
};

describe("human adoption from retained shared draft edits", () => {
  test("a service projection cannot hide an earlier human edit", async () => {
    const state = seeded();
    const update = await createDraftRevisionUpdate(state, { ...content, body: "Human contribution" }, { deadline: Date.now() + 10_000 });
    const doc = new Y.Doc();
    let later: Uint8Array;
    try {
      Y.applyUpdate(doc, state);
      Y.applyUpdate(doc, update);
      later = await createDraftRevisionUpdate(
        Y.encodeStateAsUpdate(doc),
        { ...content, body: "Service revision" },
        { deadline: Date.now() + 10_000 },
      );
    } finally {
      doc.destroy();
    }
    expect(
      await hasHumanDraftDocumentEdit({ state, generation: "1", events: events(event(update, "user"), event(later, "service_account")) }),
    ).toBeTrue();
  });
  test("service edits and old-generation human edits are not adoption", async () => {
    const state = seeded();
    const update = await createDraftRevisionUpdate(state, { ...content, subject: "Revised" }, { deadline: Date.now() + 10_000 });
    expect(await hasHumanDraftDocumentEdit({ state, generation: "1", events: events(event(update, "service_account")) })).toBeFalse();
    expect(await hasHumanDraftDocumentEdit({ state, generation: "2", events: events(event(update, "user")) })).toBeFalse();
  });
  test("an unchanged human update and a send freeze do not adopt", async () => {
    const state = seeded();
    expect(await hasHumanDraftDocumentEdit({ state, generation: "1", events: events(event(new Uint8Array([0, 0]), "user")) })).toBeFalse();
    expect(
      await hasHumanDraftDocumentEdit({ state, generation: "1", events: events({ ...event(state, "user"), kind: "freeze" }) }),
    ).toBeFalse();
  });
  test("DRAFT_ADOPTED has a stable code and useful messages in every shipped locale", () => {
    const error = { code: "DRAFT_ADOPTED", status: 409, message: "fallback" };
    for (const locale of ["en", "de", "de-DE"]) {
      const translated = localizeMailError(error, locale);
      expect(translated.code).toBe(error.code);
      expect(translated.status).toBe(409);
      expect(translated.message).toBe(draftAdoptionMessages.resolve([locale]).t.adopted);
      expect(localizeMailError({ code: "DRAFT_SUGGESTION_CONFLICT", status: 409, message: "fallback" }, locale).message).toBe(
        draftAdoptionMessages.resolve([locale]).t.mergeConflict,
      );
    }
  });
});
