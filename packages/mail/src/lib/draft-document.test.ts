import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as Y from "yjs";
import { type DraftEditableContent, draftEditableContentInputSchema } from "../contracts";
import {
  createDraftDocument,
  createDraftRevisionUpdate,
  DRAFT_BODY,
  DRAFT_SUBJECT,
  draftRecipientConfirmation,
  normalizeDraftDocumentContent,
  readDraftDocument,
  writeLocalDraftHeaders,
} from "./draft-document";

const NOW = Date.UTC(2026, 9, 23, 12);
const initial = (overrides: Partial<DraftEditableContent> = {}) =>
  draftEditableContentInputSchema.parse({
    senderIdentityId: "Send01",
    signatureTemplateId: "Sign01",
    to: [
      { address: "ada@example.test", name: "Ada" },
      { address: "ben@example.test", name: "Ben" },
    ],
    body: "Alpha middle Omega",
    subject: "Project notes",
    ...overrides,
  });
const docs: Y.Doc[] = [];
const seed = (content = initial()) => {
  const doc = createDraftDocument(content);
  docs.push(doc);
  return doc;
};
const copy = (state: Uint8Array, clientID: number) => {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  Y.applyUpdate(doc, state);
  docs.push(doc);
  return doc;
};
const update = (state: Uint8Array, content: DraftEditableContent) => {
  spyOn(Date, "now").mockReturnValue(NOW);
  return createDraftRevisionUpdate(state, content, { deadline: NOW + 10_000 });
};
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
  mock.restore();
});

describe("shared Mail draft document", () => {
  test("canonical content equates omitted and null recipient names without collapsing other choices", () => {
    const content = initial({
      to: [{ address: "to@example.test" }],
      cc: [{ address: "cc@example.test" }],
      bcc: [{ address: "bcc@example.test" }],
    });
    const expected = {
      ...content,
      to: [{ address: "to@example.test", name: null }],
      cc: [{ address: "cc@example.test", name: null }],
      bcc: [{ address: "bcc@example.test", name: null }],
    };
    const canonical = normalizeDraftDocumentContent(content);
    expect(canonical).toEqual(expected);
    expect(JSON.stringify(canonical)).toBe(JSON.stringify(normalizeDraftDocumentContent(readDraftDocument(seed(content)))));
    expect(JSON.stringify(canonical)).toBe(JSON.stringify(normalizeDraftDocumentContent(expected)));
    expect(content.to[0]).not.toHaveProperty("name");
    for (const name of ["", "Named"])
      expect(normalizeDraftDocumentContent({ ...content, to: [{ address: "to@example.test", name }] })).not.toEqual(canonical);
  });

  test("seeds identical item identities and retains every header, address order and exact body", () => {
    const content = initial({
      body: "\r\n| \\| | 😀 |\r\n",
      cc: [{ address: "C@example.test", name: null }],
      priority: "high",
      requestReadReceipt: true,
    });
    const a = seed(content),
      b = seed(content);
    expect(Y.encodeStateAsUpdate(a)).toEqual(Y.encodeStateAsUpdate(b));
    expect(readDraftDocument(a)).toEqual(content);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(readDraftDocument(a)).toEqual(content);
  });

  test("legacy disjoint edits keep intervening peer input at its original position", async () => {
    const base = seed(),
      state = Y.encodeStateAsUpdate(base);
    const peer = copy(state, 11);
    peer.getText(DRAFT_BODY).insert(12, " PEER");
    const own = await update(state, initial({ body: "ALPHA middle OMEGA" }));
    Y.applyUpdate(peer, own);
    expect(readDraftDocument(peer).body).toBe("ALPHA middle PEER OMEGA");
    const reverse = copy(state, 12);
    Y.applyUpdate(reverse, own);
    Y.applyUpdate(reverse, Y.encodeStateAsUpdate(peer));
    expect(readDraftDocument(reverse)).toEqual(readDraftDocument(peer));
  });

  test("legacy replacement deletes only its base characters, never concurrent input", async () => {
    const base = seed(initial({ body: "old" })),
      state = Y.encodeStateAsUpdate(base);
    const peer = copy(state, 21);
    peer.getText(DRAFT_BODY).insert(1, "PEER");
    Y.applyUpdate(peer, await update(state, initial({ body: "new" })));
    const body = readDraftDocument(peer).body;
    expect(body).toContain("PEER");
    expect(body.replace("PEER", "")).toBe("new");
  });

  test.each([1, 0x7fffffff, 0xffffffff])("subject replacement keeps peer text after its original edge (peer %s)", async (peerId) => {
    const base = seed(),
      state = Y.encodeStateAsUpdate(base);
    const peer = copy(state, peerId);
    peer.getText(DRAFT_SUBJECT).insert(7, " peer");
    Y.applyUpdate(peer, await update(state, initial({ subject: "PROJECT notes" })));
    expect(readDraftDocument(peer).subject).toBe("PROJECT peer notes");
  });

  test.each([1, 1000])("local subject replacements preserve the remote boundary (peer %s)", (peerId) => {
    const before = initial();
    const base = seed(before);
    const state = Y.encodeStateAsUpdate(base);
    const own = copy(state, 100);
    const peer = copy(state, peerId);
    peer.getText(DRAFT_SUBJECT).insert(7, " peer");
    writeLocalDraftHeaders(own, before, { ...before, subject: "PROJECT notes" });
    const ownUpdate = Y.encodeStateAsUpdate(own);
    Y.applyUpdate(own, Y.encodeStateAsUpdate(peer));
    Y.applyUpdate(peer, ownUpdate);
    expect(readDraftDocument(own).subject).toBe("PROJECT peer notes");
    expect(readDraftDocument(peer).subject).toBe("PROJECT peer notes");
  });

  test.each([1, 1000])("local disjoint subject edits retain the identities deleted by a peer (peer %s)", (peerId) => {
    const before = initial({ subject: "Alpha middle Omega" });
    const state = Y.encodeStateAsUpdate(seed(before));
    const own = copy(state, 100);
    const peer = copy(state, peerId);
    peer.getText(DRAFT_SUBJECT).delete(6, 7);
    writeLocalDraftHeaders(own, before, { ...before, subject: "ALPHA middle OMEGA" });
    const ownUpdate = Y.encodeStateAsUpdate(own);
    const peerUpdate = Y.encodeStateAsUpdate(peer);
    // Both publication orders, including the original writer documents.
    Y.applyUpdate(own, peerUpdate);
    Y.applyUpdate(peer, ownUpdate);
    expect(readDraftDocument(own).subject).toBe("ALPHA OMEGA");
    expect(readDraftDocument(peer).subject).toBe("ALPHA OMEGA");
  });

  test("an unrelated stale header edit keeps a concurrent recipient move to Bcc", async () => {
    const content = initial(),
      base = seed(content),
      state = Y.encodeStateAsUpdate(base);
    const moved = await update(state, { ...content, to: [content.to[0]!], bcc: [content.to[1]!] });
    const renamed = await update(state, { ...content, to: [content.to[0]!, { ...content.to[1]!, name: "Benjamin" }], priority: "high" });
    const a = copy(state, 41),
      b = copy(state, 42);
    Y.applyUpdate(a, moved);
    Y.applyUpdate(a, renamed);
    Y.applyUpdate(b, renamed);
    Y.applyUpdate(b, moved);
    expect(readDraftDocument(a)).toEqual(readDraftDocument(b));
    expect(readDraftDocument(a).to).toEqual([content.to[0]!]);
    expect(readDraftDocument(a).bcc).toEqual([{ address: "ben@example.test", name: "Benjamin" }]);
    expect(readDraftDocument(a).priority).toBe("high");
  });

  test("concurrent moves of one address converge to exactly one recipient", async () => {
    const content = initial(),
      state = Y.encodeStateAsUpdate(seed(content));
    const cc = await update(state, { ...content, to: [content.to[0]!], cc: [content.to[1]!] });
    const bcc = await update(state, { ...content, to: [content.to[0]!], bcc: [content.to[1]!] });
    const a = copy(state, 51),
      b = copy(state, 52);
    Y.applyUpdate(a, cc);
    Y.applyUpdate(a, bcc);
    Y.applyUpdate(b, bcc);
    Y.applyUpdate(b, cc);
    const result = readDraftDocument(a);
    expect(result).toEqual(readDraftDocument(b));
    expect([...result.to, ...result.cc, ...result.bcc].filter((item) => item.address === "ben@example.test")).toHaveLength(1);
  });

  test("an omitted signature retains the choice from the submitted revision", async () => {
    const content = initial(),
      state = Y.encodeStateAsUpdate(seed(content));
    const peer = copy(state, 61);
    Y.applyUpdate(peer, await update(state, { ...content, signatureTemplateId: "Sign02" }));
    Y.applyUpdate(peer, await update(state, { ...content, signatureTemplateId: undefined, subject: "Updated" }));
    expect(readDraftDocument(peer).signatureTemplateId).toBe("Sign02");
  });

  test("UTF-16 positions retain emoji around multiple edits", async () => {
    const state = Y.encodeStateAsUpdate(seed(initial({ body: "A😀 middle 🦊Z" })));
    const peer = copy(state, 71);
    peer.getText(DRAFT_BODY).insert(10, " peer");
    Y.applyUpdate(peer, await update(state, initial({ body: "B😀 middle 🦊Y" })));
    expect(readDraftDocument(peer).body).toBe("B😀 middle peer 🦊Y");
  });

  test("a duplicate legacy address is rejected instead of silently dropping a recipient", () => {
    expect(() => seed(initial({ cc: [{ address: "ADA@example.test", name: "Other" }] }))).toThrow("Duplicate draft recipient");
  });

  test("merged field limits and invisible embedded content are rejected", () => {
    const tooLong = seed();
    tooLong.getText(DRAFT_SUBJECT).insert(0, "x".repeat(998));
    expect(() => readDraftDocument(tooLong)).toThrow();
    const embedded = seed();
    embedded.getText(DRAFT_BODY).insertEmbed(0, { invisible: "input" });
    expect(() => readDraftDocument(embedded)).toThrow("unsupported embedded");
    const unknown = seed();
    unknown.getMap("hidden").set("secret", "not rendered");
    expect(() => readDraftDocument(unknown)).toThrow("Unknown draft document field");
  });

  test("expired or cancelled legacy edits fail without changing their base", async () => {
    const base = seed(),
      state = Y.encodeStateAsUpdate(base);
    spyOn(Date, "now").mockReturnValue(NOW);
    await expect(createDraftRevisionUpdate(state, initial({ body: "new" }), { deadline: NOW })).rejects.toThrow("deadline");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      createDraftRevisionUpdate(state, initial({ body: "new" }), { deadline: NOW + 10_000, signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(Y.encodeStateAsUpdate(base)).toEqual(state);
  });

  test("send confirmation changes with sender, recipient field or address inventory", () => {
    const content = initial(),
      key = draftRecipientConfirmation(content);
    expect(draftRecipientConfirmation({ ...content, body: "new" })).toBe(key);
    expect(draftRecipientConfirmation({ ...content, senderIdentityId: "Send02" })).not.toBe(key);
    expect(draftRecipientConfirmation({ ...content, to: [content.to[0]!], bcc: [content.to[1]!] })).not.toBe(key);
  });
});

describe("local Mail header edits", () => {
  test.each([
    ["", "New 😀"],
    ["Delete 😀", ""],
    ["Keep", "Keep 😀"],
    ["😀 Keep", "Keep"],
    ["😀 repeat 😀", "😃 repeat 😄"],
  ])("subject endpoints and code points survive %j to %j", (before, after) => {
    const original = initial({ subject: before });
    const doc = seed(original);
    writeLocalDraftHeaders(doc, original, { ...original, subject: after });
    expect(readDraftDocument(doc)).toEqual({ ...original, subject: after });
  });

  test("header edits preserve body and peer recipient moves", () => {
    const original = initial();
    const doc = seed(original);
    const peer = copy(Y.encodeStateAsUpdate(doc), 51);
    const moved = { ...original, to: [original.to[0]!], bcc: [original.to[1]!] };
    writeLocalDraftHeaders(peer, original, moved);
    writeLocalDraftHeaders(doc, original, { ...original, subject: "Updated notes" });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    expect(readDraftDocument(doc)).toMatchObject({ body: original.body, subject: "Updated notes", to: moved.to, bcc: moved.bcc });
  });
  test("subject edits do not split surrogate pairs sharing a high surrogate", () => {
    const original = initial({ subject: "Hello 😀 world" });
    const doc = seed(original);
    writeLocalDraftHeaders(doc, original, { ...original, subject: "Hello 😃 world" });
    expect(readDraftDocument(doc).subject).toBe("Hello 😃 world");
  });
  test.each([1, 1000])("disjoint Unicode subject replacements retain a peer deletion (peer %s)", (peerId) => {
    const original = initial({ subject: "😀 middle 😀" });
    const state = Y.encodeStateAsUpdate(seed(original));
    const own = copy(state, 100);
    const peer = copy(state, peerId);
    peer.getText(DRAFT_SUBJECT).delete(3, 7);
    writeLocalDraftHeaders(own, original, { ...original, subject: "😃 middle 😄" });
    const ownUpdate = Y.encodeStateAsUpdate(own);
    const peerUpdate = Y.encodeStateAsUpdate(peer);
    Y.applyUpdate(own, peerUpdate);
    Y.applyUpdate(peer, ownUpdate);
    expect(readDraftDocument(own).subject).toBe("😃 😄");
    expect(readDraftDocument(peer).subject).toBe("😃 😄");
  });
  test("subject contract bounds a complete replacement and rejects oversized edits before changing headers", () => {
    const original = initial({ subject: "a".repeat(998) });
    const doc = seed(original);
    writeLocalDraftHeaders(doc, original, { ...original, subject: "b".repeat(998) });
    const before = readDraftDocument(doc);
    const state = Y.encodeStateAsUpdate(doc);
    expect(before.subject).toBe("b".repeat(998));
    expect(() => writeLocalDraftHeaders(doc, before, { ...before, subject: "c".repeat(999), priority: "high" })).toThrow();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(state);
  });
  test("stale subject projections reject before changing any header", () => {
    const original = initial();
    const doc = seed(original);
    doc.getText(DRAFT_SUBJECT).insert(0, "Peer ");
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => writeLocalDraftHeaders(doc, original, { ...original, subject: "Replacement", priority: "high" })).toThrow(
      "Subject changed",
    );
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

test("a local header change cannot recreate a peer-deleted recipient from a stale control", () => {
  const original = initial();
  const doc = seed(original);
  writeLocalDraftHeaders(doc, original, { ...original, to: [original.to[0]!] });
  writeLocalDraftHeaders(doc, original, { ...original, subject: "New subject" });
  expect(readDraftDocument(doc)).toMatchObject({ to: [original.to[0]!], subject: "New subject" });
});
