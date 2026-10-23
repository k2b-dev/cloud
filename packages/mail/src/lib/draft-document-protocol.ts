import type { SharedTextProviderMessage } from "@k2b/cloud/browser/shared-text";
import { i18n } from "@k2b/stdlib";
import { z } from "zod";
import { ResourceShortIdSchema } from "../contracts";
import { draftDocumentUpdateSchema, draftGenerationSchema, MAX_DRAFT_DOCUMENT_PAYLOAD } from "./draft-document-contract";

/** Notebooks' existing transient cursor envelope, separate from the 8 MB document envelope. */
export const MAX_DRAFT_AWARENESS_PAYLOAD = 256_000;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const bytes = (limit: number) => z.string().min(1).max(limit).regex(base64);
const cursor = z.string().max(256);
const doc = { docId: ResourceShortIdSchema };

export const mailDraftDocumentRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("replayRequest"),
    payload: z.strictObject({ ...doc, fromCursor: cursor.nullable(), generation: draftGenerationSchema.nullable() }),
  }),
  z.strictObject({
    type: z.literal("syncPublish"),
    payload: draftDocumentUpdateSchema.extend({ ...doc, payload: bytes(MAX_DRAFT_DOCUMENT_PAYLOAD) }),
  }),
  z.strictObject({
    type: z.literal("awarenessPublish"),
    payload: z.strictObject({ ...doc, generation: draftGenerationSchema, payload: bytes(MAX_DRAFT_AWARENESS_PAYLOAD) }),
  }),
]);
export type MailDraftDocumentRequest = z.infer<typeof mailDraftDocumentRequestSchema>;

const update = z.strictObject({
  payload: bytes(MAX_DRAFT_DOCUMENT_PAYLOAD),
  cursor: cursor.optional(),
  generation: draftGenerationSchema,
  originPeerId: z.string().max(128).nullable().optional(),
  actionId: z.string().max(256).optional(),
  retainedColumn: z.boolean().optional(),
});
export const mailDraftDocumentMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("replayReady"),
    payload: z.strictObject({ ...doc, generation: draftGenerationSchema, cursor, peerId: z.string().max(128) }),
  }),
  z.strictObject({
    type: z.literal("syncPush"),
    payload: z.strictObject({
      ...doc,
      generation: draftGenerationSchema,
      snapshot: z.boolean().optional(),
      historyIncomplete: z.boolean().optional(),
      updates: z.array(update).min(1).max(100),
    }),
  }),
  z.strictObject({
    type: z.literal("awarenessPush"),
    payload: z.strictObject({
      ...doc,
      generation: draftGenerationSchema,
      updates: z
        .array(update.extend({ payload: bytes(MAX_DRAFT_AWARENESS_PAYLOAD) }))
        .min(1)
        .max(100),
    }),
  }),
  z.strictObject({
    type: z.literal("error"),
    payload: z.strictObject({
      ...doc,
      code: z.string().min(1).max(64),
      message: z.string().min(1).max(1000),
      reopen: z.boolean().optional(),
    }),
  }),
]);
export type MailDraftDocumentMessage = z.infer<typeof mailDraftDocumentMessageSchema>;

/** The route's public draft ID is the scope; a packet may never redirect a provider. */
export const decodeMailDraftDocumentMessage = (packet: unknown, docId: string): SharedTextProviderMessage | null => {
  const parsed = mailDraftDocumentMessageSchema.safeParse(packet);
  return parsed.success && parsed.data.payload.docId === docId ? parsed.data : null;
};

export const MAIL_DRAFT_DOCUMENT_TERMINAL_CODES = [
  "SESSION_EXPIRED",
  "ACCESS_DENIED",
  "DOCUMENT_NOT_FOUND",
  "INVALID_PAYLOAD",
  "BACKPRESSURE",
] as const;

export const mailDraftDocumentMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      session: "Your session ended. Sign in again to continue editing.",
      access: "You no longer have access to edit this draft.",
      missing: "This draft is no longer available.",
      reopen: "This draft changed or is no longer editable. Copy unsent text before reopening it.",
      invalid: "The editing update could not be read. Copy unsent text before reopening the draft.",
      network: "The editing connection was interrupted. Reconnecting…",
      pending: "Your changes could not yet be saved. Keep this draft open and retry saving.",
      busy: "The editing connection could not keep up. Copy unsent text before reopening the draft.",
    },
    de: {
      session: "Deine Sitzung ist beendet. Melde dich erneut an, um weiterzuschreiben.",
      access: "Du hast keinen Zugriff mehr, um diesen Entwurf zu bearbeiten.",
      missing: "Dieser Entwurf ist nicht mehr verfügbar.",
      reopen: "Dieser Entwurf hat sich geändert oder ist nicht mehr bearbeitbar. Kopiere ungesendeten Text, bevor du ihn erneut öffnest.",
      invalid: "Die Änderung konnte nicht gelesen werden. Kopiere ungesendeten Text, bevor du den Entwurf erneut öffnest.",
      network: "Die Verbindung zum Bearbeiten wurde unterbrochen. Sie wird wiederhergestellt…",
      pending: "Deine Änderungen konnten noch nicht gespeichert werden. Lass den Entwurf geöffnet und versuche das Speichern erneut.",
      busy: "Die Verbindung konnte mit den Änderungen nicht Schritt halten. Kopiere ungesendeten Text, bevor du den Entwurf erneut öffnest.",
    },
  },
});
