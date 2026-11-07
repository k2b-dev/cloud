import { type Change, diffChars } from "diff";
import * as Y from "yjs";
import { z } from "zod";
import { type DraftEditableContent, draftEditableContentInputSchema, mailAddressSchema } from "../contracts";

// Body shares the platform editor's existing identity; headers belong to Mail.
export const DRAFT_BODY = "codemirror";
export const DRAFT_SUBJECT = "mail.subject";
const SETTINGS = "mail.settings";
const RECIPIENTS = "mail.recipients";
const fields = ["to", "cc", "bcc"] as const;

/** SQL/API recipients may omit a name; Yjs projects the same choice as null. */
export const normalizeDraftDocumentContent = (input: DraftEditableContent): DraftEditableContent => {
  const content = draftEditableContentInputSchema.parse(input);
  const addresses = (entries: DraftEditableContent["to"]) => entries.map(({ address, name }) => ({ address, name: name ?? null }));
  return { ...content, to: addresses(content.to), cc: addresses(content.cc), bcc: addresses(content.bcc) };
};

const settingKeys = [
  "senderIdentityId",
  "signatureTemplateId",
  "format",
  "priority",
  "requestDeliveryReceipt",
  "requestReadReceipt",
] as const;
const recipientSchema = mailAddressSchema
  .extend({
    field: z.enum(fields),
    order: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const addressKey = (address: string) => address.trim().toLowerCase();
const recipientEntries = (content: DraftEditableContent) => {
  const entries = new Map<string, z.infer<typeof recipientSchema>>();
  for (const field of fields) {
    content[field].forEach((address, order) => {
      const key = addressKey(address.address);
      // A legacy duplicate cannot be silently collapsed when entering shared mode.
      if (entries.has(key)) throw new Error("Duplicate draft recipient requires recovery before shared editing");
      entries.set(key, { field, order, address: address.address, name: address.name ?? null });
    });
  }
  return entries;
};

const settingsOf = (content: DraftEditableContent) => ({
  senderIdentityId: content.senderIdentityId,
  signatureTemplateId: content.signatureTemplateId ?? null,
  format: content.format,
  priority: content.priority,
  requestDeliveryReceipt: content.requestDeliveryReceipt,
  requestReadReceipt: content.requestReadReceipt,
});

const plainText = (text: Y.Text): string => {
  if (
    text
      .toDelta()
      .some(
        (part: { insert?: unknown; attributes?: Record<string, unknown> }) =>
          typeof part.insert !== "string" || (part.attributes && Object.keys(part.attributes).length),
      )
  ) {
    throw new Error("Draft text contains unsupported embedded content");
  }
  return text.toString();
};

/** The application validates the merged document, never only the incoming delta. */
export const readDraftDocument = (doc: Y.Doc): DraftEditableContent => {
  if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error("Draft document has unresolved dependencies");
  for (const key of doc.share.keys()) {
    if (![DRAFT_BODY, DRAFT_SUBJECT, SETTINGS, RECIPIENTS].includes(key)) throw new Error("Unknown draft document field");
  }
  const settings = doc.getMap<unknown>(SETTINGS);
  for (const key of settings.keys()) {
    if (!settingKeys.some((known) => known === key)) throw new Error("Unknown draft setting");
  }
  const recipients = [...doc.getMap<Y.Map<unknown>>(RECIPIENTS)].map(([key, value]) => {
    if (!(value instanceof Y.Map)) throw new Error("Invalid draft recipient");
    const recipient = recipientSchema.parse(value.toJSON());
    if (key !== addressKey(recipient.address)) throw new Error("Invalid draft recipient identity");
    return { key, ...recipient };
  });
  const inField = (field: (typeof fields)[number]) =>
    recipients
      .filter((entry) => entry.field === field)
      .sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(({ address, name }) => ({ address, name: name ?? null }));
  return draftEditableContentInputSchema.parse({
    ...Object.fromEntries(settings),
    to: inField("to"),
    cc: inField("cc"),
    bcc: inField("bcc"),
    subject: plainText(doc.getText(DRAFT_SUBJECT)),
    body: plainText(doc.getText(DRAFT_BODY)),
  });
};

const writeHeaders = (doc: Y.Doc, before: DraftEditableContent | null, next: DraftEditableContent) => {
  const settings = doc.getMap<unknown>(SETTINGS);
  const previousSettings = before && settingsOf(before);
  const nextSettings = settingsOf(next);
  for (const key of settingKeys) {
    if (!previousSettings || previousSettings[key] !== nextSettings[key]) settings.set(key, nextSettings[key]);
  }
  const recipients = doc.getMap<Y.Map<unknown>>(RECIPIENTS);
  const previous = before ? recipientEntries(before) : new Map<string, z.infer<typeof recipientSchema>>();
  const desired = recipientEntries(next);
  for (const key of previous.keys()) if (!desired.has(key)) recipients.delete(key);
  for (const [key, recipient] of desired) {
    const old = previous.get(key);
    const changed = (["address", "name", "field", "order"] as const).filter((field) => !old || old[field] !== recipient[field]);
    if (!changed.length) continue;
    let entry = recipients.get(key);
    // A stale control must not recreate a recipient removed by a peer. Its
    // old nested-map identity is gone; the next projection exposes the removal.
    if (!entry && old) continue;
    if (!entry) {
      entry = new Y.Map<unknown>();
      recipients.set(key, entry);
    }
    // A move, display-name edit and ordering change use separate Yjs keys.
    // An unrelated legacy edit must not overwrite another person's move to Bcc.
    for (const field of changed) entry.set(field, recipient[field]);
  }
};

type TextChange = Pick<Change, "value" | "added" | "removed">;

const localSubjectChanges = (before: string, next: string): TextChange[] => {
  if (before === next) return [];
  // The subject contract bounds each input to 998 UTF-16 units. A numeric
  // LCS table bounds work to their product, without jsdiff's path allocations
  // on a complete replacement. Code points keep surrogate pairs intact.
  const oldChars = Array.from(draftEditableContentInputSchema.shape.subject.parse(before));
  const newChars = Array.from(draftEditableContentInputSchema.shape.subject.parse(next));
  const width = newChars.length + 1;
  const common = new Uint16Array((oldChars.length + 1) * width);
  for (let old = oldChars.length - 1; old >= 0; old--)
    for (let added = newChars.length - 1; added >= 0; added--)
      common[old * width + added] =
        oldChars[old] === newChars[added]
          ? 1 + common[(old + 1) * width + added + 1]!
          : Math.max(common[(old + 1) * width + added]!, common[old * width + added + 1]!);
  const changes: TextChange[] = [];
  const append = (value: string, added: boolean, removed: boolean) => {
    const last = changes.at(-1);
    if (last && last.added === added && last.removed === removed) last.value += value;
    else changes.push({ value, added, removed });
  };
  let old = 0,
    added = 0;
  while (old < oldChars.length || added < newChars.length) {
    if (old < oldChars.length && added < newChars.length && oldChars[old] === newChars[added]) {
      append(oldChars[old++]!, false, false);
      added++;
    } else if (
      added < newChars.length &&
      (old === oldChars.length || common[old * width + added + 1]! > common[(old + 1) * width + added]!)
    ) {
      append(newChars[added++]!, true, false);
    } else append(oldChars[old++]!, false, true);
  }
  return changes;
};

/** Local header controls edit only changed fields; CodeMirror exclusively owns the body. */
export const writeLocalDraftHeaders = (doc: Y.Doc, before: DraftEditableContent, next: DraftEditableContent): void => {
  draftEditableContentInputSchema.parse(next);
  recipientEntries(next);
  if (before.subject !== next.subject && doc.getText(DRAFT_SUBJECT).toString() !== before.subject)
    throw new Error("Subject changed; refresh the header before editing");
  const subjectChanges = localSubjectChanges(before.subject, next.subject);
  doc.transact(() => {
    writeHeaders(doc, before, next);
    applyTextChanges(doc.getText(DRAFT_SUBJECT), subjectChanges);
  }, "mail-headers");
};

/** Same legacy input creates identical Yjs items even when two pods seed it. */
export const createDraftDocument = (input: DraftEditableContent): Y.Doc => {
  const content = draftEditableContentInputSchema.parse(input);
  recipientEntries(content);
  const doc = new Y.Doc();
  const writer = doc.clientID;
  doc.clientID = 0;
  try {
    doc.transact(() => {
      doc.getText(DRAFT_BODY).insert(0, content.body);
      doc.getText(DRAFT_SUBJECT).insert(0, content.subject);
      writeHeaders(doc, null, content);
    }, "legacy-draft");
    return doc;
  } catch (error) {
    doc.destroy();
    throw error;
  } finally {
    doc.clientID = writer;
  }
};

const textChanges = (before: string, after: string, deadline: number, signal?: AbortSignal): Promise<Change[]> => {
  signal?.throwIfAborted();
  if (before === after) return Promise.resolve([]);
  const remaining = deadline - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return Promise.reject(new Error("Draft edit exceeded its request deadline"));
  // The caller supplies its existing request budget. Async diffing yields to
  // other requests, and an exhausted budget leads to recovery, not replacement.
  return new Promise((resolve, reject) => {
    diffChars(before, after, {
      timeout: remaining,
      callback: (parts) => {
        if (signal?.aborted) reject(signal.reason);
        else if (!parts) reject(new Error("Draft edit exceeded its request deadline"));
        else resolve(parts);
      },
    });
  });
};

const applyTextChanges = (text: Y.Text, changes: TextChange[]) => {
  let offset = 0;
  for (let index = 0; index < changes.length; ) {
    const part = changes[index]!;
    if (!part.added && !part.removed) {
      offset += part.value.length;
      index++;
      continue;
    }
    let removed = 0;
    let inserted = "";
    while (index < changes.length && (changes[index]!.added || changes[index]!.removed)) {
      const change = changes[index++]!;
      if (change.removed) removed += change.value.length;
      else inserted += change.value;
    }
    // Insert while the replaced base characters still anchor the right edge.
    // Deleting first makes a peer's insertion at that edge compete with our
    // replacement under a common ancestor, reordering it by writer ID.
    // jsdiff counts code points; positions here use the strings' UTF-16 lengths.
    if (inserted) text.insert(offset, inserted);
    if (removed) text.delete(offset + inserted.length, removed);
    offset += inserted.length;
  }
};

/**
 * Revision writers edit the reconstructed BASE identities, not today's text.
 * Applying this delta to the current document preserves intervening peer edits.
 * The service must first authenticate the revision and generation of baseState.
 * Compile once per logical operation: its retained publication is the retry
 * receipt. Recompiling creates different insertion identities, even on the
 * same base. The Mail revision service owns that authenticated reuse.
 */
export const createDraftRevisionUpdate = async (
  baseState: Uint8Array,
  input: DraftEditableContent,
  options: { deadline: number; signal?: AbortSignal },
): Promise<Uint8Array> => {
  options.signal?.throwIfAborted();
  const submitted = draftEditableContentInputSchema.parse(input);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, baseState);
    const before = readDraftDocument(doc);
    const next = {
      ...submitted,
      signatureTemplateId: submitted.signatureTemplateId === undefined ? before.signatureTemplateId : submitted.signatureTemplateId,
    };
    recipientEntries(next);
    const body = await textChanges(before.body, next.body, options.deadline, options.signal);
    const subject = await textChanges(before.subject, next.subject, options.deadline, options.signal);
    options.signal?.throwIfAborted();
    const vector = Y.encodeStateVector(doc);
    doc.transact(() => {
      applyTextChanges(doc.getText(DRAFT_BODY), body);
      applyTextChanges(doc.getText(DRAFT_SUBJECT), subject);
      writeHeaders(doc, before, next);
    }, "revision-edit");
    readDraftDocument(doc);
    return Y.encodeStateAsUpdate(doc, vector);
  } finally {
    doc.destroy();
  }
};

/** The exact sender/recipient inventory that a person's send confirmation covers. */
export const draftRecipientConfirmation = (content: DraftEditableContent): string =>
  JSON.stringify({ senderIdentityId: content.senderIdentityId, to: content.to, cc: content.cc, bcc: content.bcc });
