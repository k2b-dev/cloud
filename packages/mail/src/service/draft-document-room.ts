import { lazySync, sql } from "@k2b/cloud";
import { auth } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import {
  createSharedTextRoom,
  type SharedTextEvent,
  type SharedTextRoomContext,
  type SharedTextRoomMessages,
} from "@k2b/cloud/shared-text";
import * as Y from "yjs";
import { z } from "zod";
import { ResourceShortIdSchema } from "../contracts";
import { MAX_DRAFT_DOCUMENT_PAYLOAD } from "../draft-document-contracts";
import { readDraftDocument as projectDocument } from "../lib/draft-document";
import { requireDraftAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { removeOrphanComposeSegmentMarks } from "./compose-renderer";
import { draftDocumentBudget } from "./draft-document-budget";
import { mailDraftDocumentLog } from "./draft-document-log";
import {
  draftDocumentSnapshotStore,
  draftDocumentSnapshots,
  flushDraftDocumentSnapshot,
  markDraftDocumentDirty,
} from "./draft-document-snapshots";
import { readDraftDocument } from "./draft-documents";
import { requireDraftLeaseAvailable } from "./draft-leases";
import { mailLive } from "./live";

const log = logger("mail:draft-document-room");
type Session = NonNullable<Awaited<ReturnType<typeof auth.session.authenticate>>>;
export type MailDraftRoomMessages = SharedTextRoomMessages & {
  document: {
    mailboxId: string;
    draftId: string;
    publicId: string;
    userId: string;
    requestId: string | null;
    signal: AbortSignal;
    senders: Set<string>;
    signatures: Set<string>;
    seededSignature: string | null;
    generation: string | null;
  };
};
export type MailDraftRoomContext = SharedTextRoomContext<Session, MailDraftRoomMessages>;
const contextFor = (session: Session, requestId: string | null): MailRequestContext => ({
  actor: { kind: "user", user: session.user, ...(session.data.kind === "app" ? { sessionKind: "app" as const } : {}) },
  accessSubject: { type: "user", userId: session.user.id },
  requestId,
});
const awarenessTopic = lazySync((sync) =>
  sync.topic<SharedTextEvent & { kind: "awareness" }>({
    id: "cloud:mail:draft-document-awareness",
    retention: { maxAgeMs: 60_000, maxBytes: 64 * 1024 * 1024 },
    dedupeWindowMs: 60_000,
    maxPayloadBytes: 300_000 + 4096,
  }),
);
const color = (id: string) => {
  const colors = ["#e06c75", "#61afef", "#98c379", "#d19a66", "#c678dd", "#56b6c2", "#e5c07b"];
  let hash = 0;
  for (const character of id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length]!;
};

const authorize = async (id: string, session: Session, messages: MailDraftRoomMessages) => {
  const scope = messages.document;
  const { mailboxId, draftId, publicId, userId, signal } = scope;
  if (id !== publicId || session.user.id !== userId) return { ok: false, code: "ACCESS_DENIED" };
  // Capture the retained access stream before SQL so a concurrent revocation cannot fall between join and watch.
  const invalidationCursor = await mailLive.cursor();
  const context = contextFor(session, scope.requestId);
  const access = await requireDraftAccess(context, mailboxId, draftId, "write");
  if (!access.ok) return { ok: false, code: "ACCESS_DENIED", message: messages.accessDenied };
  const lease = await requireDraftLeaseAvailable({ context, mailboxId, draftId });
  if (!lease.ok) return { ok: false, code: "ACCESS_DENIED", message: lease.error.message };
  const read = await readDraftDocument({ context, mailboxId, draftId, signal });
  if (!read.ok) return { ok: false, code: "RESYNC_REQUIRED", message: messages.reopenRequired };
  if (read.data.lifecycle !== "draft" || read.data.frozen || !read.data.historyComplete)
    return { ok: false, code: "RESYNC_REQUIRED", message: messages.reopenRequired };
  scope.generation = read.data.generation;
  scope.seededSignature = read.data.durable.content.signatureTemplateId ?? null;
  const identities = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.sender_identities
      WHERE mailbox_id = ${mailboxId}::uuid AND status = 'verified'`;
  const templates = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.compose_templates
      WHERE mailbox_id = ${mailboxId}::uuid AND kind = 'signature' AND archived_at IS NULL
        AND (scope = 'mailbox' OR owner_user_id = ${session.user.id}::uuid)`;
  scope.senders = new Set(identities.map((row) => row.short_id));
  scope.signatures = new Set(templates.map((row) => row.short_id));
  return { ok: true, resolvedDocId: draftId, scope: mailboxId, invalidationCursor, canWrite: true };
};
export const mailDraftRoom = createSharedTextRoom<Session, MailDraftRoomMessages>({
  log: mailDraftDocumentLog,
  awarenessTopic,
  logger: log,
  maxLength: 2_097_152,
  deliveryBudget: {
    claim: (bytes) => draftDocumentBudget.claim("delivery", bytes),
    release: (bytes) => draftDocumentBudget.release("delivery", bytes),
  },
  protocol: {
    wsType: {
      replayRequest: "replayRequest",
      replayReady: "replayReady",
      syncPublish: "syncPublish",
      syncPush: "syncPush",
      awarenessPublish: "awarenessPublish",
      awarenessPush: "awarenessPush",
      error: "error",
    },
    documentId: ResourceShortIdSchema,
    maxSyncPayloadLength: MAX_DRAFT_DOCUMENT_PAYLOAD,
    streamCursorPattern: /^s6t\./,
    decode: (packet) => {
      if (!packet || typeof packet !== "object" || !("payload" in packet) || !packet.payload || typeof packet.payload !== "object")
        return packet;
      return {
        ...packet,
        payload: { ...packet.payload, restoreRevision: "generation" in packet.payload ? packet.payload.generation : undefined },
      };
    },
    encode: (type, payload, ctx) => {
      if (!payload || typeof payload !== "object") return { type, payload };
      const { restoreRevision, ...rest } = z.record(z.string(), z.unknown()).parse(payload);
      const generation = restoreRevision ?? ctx.restoreRevision;
      if (Array.isArray(rest.updates))
        rest.updates = rest.updates.map((update: unknown) => {
          const { restoreRevision: revision, cursor, ...fields } = z.record(z.string(), z.unknown()).parse(update);
          return { ...fields, generation: revision ?? generation, ...(cursor ? { cursor } : {}) };
        });
      return { type, payload: { ...rest, ...(type === "error" ? {} : { generation }) } };
    },
  },
  validateState: (state, ctx) => {
    const { senders, signatures, seededSignature } = ctx.messages.document;
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, state);
      const content = projectDocument(doc);
      return (
        senders.has(content.senderIdentityId) &&
        (content.signatureTemplateId === null ||
          content.signatureTemplateId === seededSignature ||
          (typeof content.signatureTemplateId === "string" && signatures.has(content.signatureTemplateId))) &&
        removeOrphanComposeSegmentMarks(content.body) === content.body
      );
    } catch {
      return false;
    } finally {
      doc.destroy();
    }
  },
  snapshots: {
    markDirty: markDraftDocumentDirty,
    flushNow: (docId, options) => flushDraftDocumentSnapshot(docId, options),
    queue: async ({ docId, targetCursor, reason }) => {
      if (reason === "unload") await flushDraftDocumentSnapshot(docId);
      else await draftDocumentSnapshots.queue({ docId, targetCursor, reason });
    },
  },
  adapter: {
    authenticate: async (token) => (token ? auth.session.authenticate(token) : null),
    authorize,
    load: (docId) => draftDocumentSnapshotStore.load(docId, {}),
    actor: (session) => ({ kind: "user", id: session.user.id }),
    awarenessUser: (session) => ({ userId: session.user.id, name: session.user.displayName, color: color(session.user.id) }),
    revalidate: async (current) => {
      const session = current.sessionToken ? await auth.session.authenticate(current.sessionToken) : null;
      const { userId, publicId } = current.messages.document;
      if (!session || session.user.id !== userId) return { ok: false, code: "SESSION_EXPIRED", message: current.messages.sessionExpired };
      const access = await authorize(publicId, session, current.messages);
      if (access.ok && current.restoreRevision !== current.messages.document.generation)
        return { ok: false, code: "RESYNC_REQUIRED", message: current.messages.reopenRequired };
      return access;
    },
    invalidations: async function* (current, signal) {
      if (!current.invalidationCursor) return;
      for await (const event of mailLive.accessChanges({ after: current.invalidationCursor, signal }))
        if (event.key === current.messages.document.mailboxId) yield event;
    },
    recover: (docId, cause, signal) => draftDocumentSnapshotStore.recover(docId, cause, { signal }),
  },
});
