import { type SharedTextStore, sharedText, sharedTextNodeId } from "@k2b/cloud/shared-text";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { ConflictError } from "@k2b/sync";
import { inspectTableStructure } from "@k2b/ui/text-editor/model";
import type { sql } from "bun";
import * as Y from "yjs";
import { type DraftEditableContent, draftEditableContentInputSchema } from "../contracts";
import {
  createDraftDocument,
  createDraftRevisionUpdate,
  normalizeDraftDocumentContent,
  readDraftDocument as projectDocument,
} from "../lib/draft-document";
import { requireDraftAccess } from "./access";
import { actorRefFromRequest, type MailRequestContext } from "./auth";
import { removeOrphanComposeSegmentMarks } from "./compose-renderer";
import { DRAFT_REVISION_OPERATION_ORIGIN, draftRevisionOperationContent, findDraftRevisionOperation } from "./draft-document-operation";
import { awaitDraftDocumentQuery, withDraftDocumentTransaction } from "./draft-document-socket-sql";
import { queueDraftProjectionInTransaction } from "./draft-provider-projection";
import { resolveDraftSignature, validateIdentity } from "./draft-validation";

const MAX_LOG_ENVELOPE_BYTES = 8_100_000 + 4096;

/**
 * Preparation only: lock remains the default. Sync #4 (reject-full, no expiry
 * before snapshot coverage, watermark pruning) blocks activation. These are
 * supported Sync 7 settings, using the existing Notebooks budget: 1 GiB holds
 * about 149 KiB/s for a two-hour stalled projection window, or 132 maximum
 * updates. The unused dead-letter stream has room for two maximum envelopes.
 * Merely importing this declaration does not provision or activate a log.
 */
export const mailDraftDocumentLog = sharedText.define({
  id: "cloud:mail:draft-documents",
  retention: { maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxBytes: 1024 ** 3 },
  deadLetterRetention: { maxBytes: 16 * 1024 * 1024 },
  maxPayloadBytes: MAX_LOG_ENVELOPE_BYTES,
});

type Db = typeof sql;
type DraftRow = {
  id: string;
  state: string;
  edit_mode: "lock" | "shared";
  author_kind: string;
  revision: string | number;
  doc_generation: string | number;
  doc_state: Uint8Array | null;
  doc_cursor: string | null;
  doc_seq: string | number | null;
  doc_history_complete: boolean;
  doc_frozen_cursor: string | null;
  doc_frozen_state: Uint8Array | null;
  doc_frozen_generation: string | number | null;
  doc_frozen_revision: string | number | null;
  sender_identity_id: string;
  signature_template_id: string | null;
  sender_short_id: string | null;
  signature_short_id: string | null;
  to_addresses: DraftEditableContent["to"] | string;
  cc_addresses: DraftEditableContent["cc"] | string;
  bcc_addresses: DraftEditableContent["bcc"] | string;
  subject: string;
  body_markdown: string;
  body_format: DraftEditableContent["format"];
  priority: DraftEditableContent["priority"];
  request_delivery_receipt: boolean;
  request_read_receipt: boolean;
};

type Target = { context: MailRequestContext; mailboxId: string; draftId: string; signal?: AbortSignal };
export type DraftDocumentSnapshot = { state: Uint8Array; cursor: string | null; content: DraftEditableContent };
export type DraftDocumentRead = {
  generation: string;
  revision: number;
  lifecycle: string;
  historyComplete: boolean;
  fresh: DraftDocumentSnapshot;
  /** Only bytes stored in this SQL transaction; replay alone is not durable. */
  durable: DraftDocumentSnapshot;
  frozen: { state: Uint8Array; cursor: string; generation: string; revision: number } | null;
};
export type DraftDocumentAdmission =
  | { status: "accepted"; cursor: string; revision: number; durable: DraftDocumentSnapshot }
  | { status: "pendingPersistence"; cursor: string; message: string }
  | { status: "recoveryRequired"; message: string };
export type DraftDocumentSave = { status: "saved" | "covered"; revision: number; durable: DraftDocumentSnapshot };
export type DraftDocumentFreeze = {
  state: Uint8Array;
  cursor: string;
  generation: string;
  revision: number;
  content: DraftEditableContent;
};

type AcceptInput = {
  update: Uint8Array;
  baseCursor: string | null;
  generation: string;
  originNodeId?: string;
  originPeerId?: string | null;
  signal?: AbortSignal;
};
export type LockedDraftDocument = {
  readonly generation: string;
  readonly revision: number;
  readonly publishedCursor: string | null;
  store: SharedTextStore<DraftDocumentSave, undefined>;
  read(): Promise<Result<DraftDocumentRead>>;
  project(): Promise<Result<DraftDocumentSave>>;
  /** After an attachment-only revision bump, authenticate that revision's unchanged document. */
  recordRevisionBase(): Promise<Result<{ revision: number; cursor: string | null }>>;
  accept(input: AcceptInput): Promise<Result<DraftDocumentAdmission>>;
  writeRevision(input: {
    expectedRevision: number;
    generation: string;
    content: DraftEditableContent;
    deadline: number;
    signal?: AbortSignal;
  }): Promise<Result<DraftDocumentAdmission>>;
  freeze(input: { generation: string; signal?: AbortSignal }): Promise<Result<DraftDocumentFreeze>>;
};

const conflict = (message: string): Result<never> => fail(err.conflict(message));
const recovery = (message: string): Result<DraftDocumentAdmission> => ok({ status: "recoveryRequired", message });
const decode = (state: Uint8Array): DraftEditableContent => {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return projectDocument(doc);
  } finally {
    doc.destroy();
  }
};
const snapshot = (row: DraftRow): DraftDocumentSnapshot => {
  if (!row.doc_state) throw new Error("Draft document has not been seeded");
  return { state: row.doc_state, cursor: row.doc_cursor, content: decode(row.doc_state) };
};
const editable = (row: DraftRow): Result<void> => {
  if (row.edit_mode !== "shared") return conflict("Draft uses lock editing; shared document APIs are unavailable");
  if (row.state !== "draft" || row.doc_frozen_cursor !== null) return conflict("Draft document is frozen or no longer editable");
  if (row.author_kind === "workflow") return conflict("Workflow drafts cannot use interactive shared editing");
  if (!row.doc_history_complete) return conflict("Draft document history is incomplete; recovery is required");
  return ok();
};

/**
 * Open only inside an existing SQL transaction, and use the returned handle
 * only until that transaction ends. The row lock is the same lock send takes.
 * Every mutator rechecks write access, generation, mode and state before any
 * publication. No process-local mutex or per-draft stream is involved.
 */
export const lockDraftDocumentInTransaction = async (
  params: Target & { db: Db; permission?: "read" | "write" },
): Promise<Result<LockedDraftDocument>> => {
  const { db, context, mailboxId, draftId } = params;
  const actorRef = actorRefFromRequest(context);
  const actor =
    actorRef.kind === "user"
      ? { kind: "user" as const, id: actorRef.userId }
      : actorRef.kind === "service_account"
        ? { kind: "service_account" as const, id: actorRef.serviceAccountId }
        : null;
  if (!actor) return fail(err.forbidden("Draft editor is invalid"));

  const loadRow = async (): Promise<DraftRow | null> => {
    const [row] = await awaitDraftDocumentQuery(
      db<DraftRow[]>`
      SELECT d.*, sender.short_id AS sender_short_id, signature.short_id AS signature_short_id
      FROM mail.drafts d
      LEFT JOIN mail.sender_identities sender ON sender.id = d.sender_identity_id AND sender.mailbox_id = d.mailbox_id
      LEFT JOIN mail.compose_templates signature ON signature.id = d.signature_template_id AND signature.mailbox_id = d.mailbox_id
      WHERE d.id = ${draftId}::uuid AND d.mailbox_id = ${mailboxId}::uuid AND d.origin = 'user'
      FOR UPDATE OF d
    `,
      params.signal,
    );
    return row ?? null;
  };
  params.signal?.throwIfAborted();
  const entry = await requireDraftAccess(context, mailboxId, draftId, params.permission ?? "write", db);
  if (!entry.ok) return entry;
  const initial = await loadRow();
  // An authorized request may have waited behind send or an assignment change.
  const allowed = await requireDraftAccess(context, mailboxId, draftId, params.permission ?? "write", db);
  if (!allowed.ok) return allowed;
  if (!initial) return fail(err.notFound("Draft"));
  let row: DraftRow = initial;
  if (row.edit_mode !== "shared") return conflict("Draft uses lock editing; shared document APIs are unavailable");
  if ((params.permission ?? "write") === "write") {
    const ready = editable(row);
    if (!ready.ok) return ready;
  }

  const generation = String(row.doc_generation);
  let publishedCursor: string | null = null;
  const assertWritable = async (expectedGeneration: string): Promise<Result<void>> => {
    params.signal?.throwIfAborted();
    const permission = await requireDraftAccess(context, mailboxId, draftId, "write", db);
    if (!permission.ok) return permission;
    const current = await loadRow();
    if (!current) return fail(err.notFound("Draft"));
    row = current;
    const ready = editable(row);
    if (!ready.ok) return ready;
    return String(row.doc_generation) === expectedGeneration ? ok() : conflict("Draft document generation changed; recovery is required");
  };

  /** Transport conversion is mailbox-scoped; UUIDs never enter the Y.Doc. */
  const validateContent = async (content: DraftEditableContent, stored: DraftRow) => {
    if (content.signatureTemplateId === undefined) return conflict("Shared documents require an explicit signature choice");
    const [identity] = await db<{ id: string }[]>`
      SELECT id FROM mail.sender_identities
      WHERE short_id = ${content.senderIdentityId} AND mailbox_id = ${mailboxId}::uuid
    `;
    if (!identity) return fail(err.badInput("The selected sender identity is not available"));
    const verified = await validateIdentity({ db, mailboxId, senderIdentityId: identity.id });
    if (!verified.ok) return verified;
    let signatureId: string | null = stored.signature_template_id;
    if (content.signatureTemplateId !== undefined) {
      signatureId = null;
      if (content.signatureTemplateId !== null) {
        const [signature] = await awaitDraftDocumentQuery(
          db<{ id: string }[]>`
          SELECT id FROM mail.compose_templates
          WHERE short_id = ${content.signatureTemplateId} AND mailbox_id = ${mailboxId}::uuid
          FOR SHARE
        `,
          params.signal,
        );
        if (!signature) return fail(err.badInput("The selected signature is not available"));
        signatureId = signature.id;
      }
    }
    const signature = await resolveDraftSignature({
      db,
      context,
      mailboxId,
      stored: { body: stored.body_markdown, signatureTemplateId: stored.signature_template_id },
      body: content.body,
      requested: content.signatureTemplateId === undefined ? undefined : signatureId,
    });
    if (!signature.ok) return signature;
    // Projection must reproduce the exact full document. Never silently trim
    // or extract a signature after publication and save different SQL bytes.
    if (signature.data.body !== content.body || removeOrphanComposeSegmentMarks(content.body) !== content.body)
      return conflict("Draft signature segments require normalization before shared admission");
    return ok({ senderIdentityId: identity.id, signatureTemplateId: signature.data.signatureTemplateId });
  };

  if (!row.doc_state) {
    const ready = editable(row);
    if (!ready.ok) return ready;
    if (row.doc_cursor !== null || row.doc_seq !== null) return conflict("Draft document snapshot is missing; recovery is required");
    const signature = await resolveDraftSignature({
      db,
      context,
      mailboxId,
      stored: { body: row.body_markdown, signatureTemplateId: row.signature_template_id },
      body: row.body_markdown,
      requested: undefined,
    });
    if (!signature.ok) return signature;
    let signatureShortId: string | null = null;
    if (signature.data.signatureTemplateId !== null) {
      const [selected] = await db<{ short_id: string }[]>`
        SELECT short_id FROM mail.compose_templates
        WHERE id = ${signature.data.signatureTemplateId}::uuid AND mailbox_id = ${mailboxId}::uuid
        FOR SHARE
      `;
      if (!selected) return conflict("Draft signature is unavailable; recovery is required");
      signatureShortId = selected.short_id;
    }
    let state: Uint8Array;
    try {
      const content = draftEditableContentInputSchema.parse({
        senderIdentityId: row.sender_short_id,
        signatureTemplateId: signatureShortId,
        to: typeof row.to_addresses === "string" ? JSON.parse(row.to_addresses) : row.to_addresses,
        cc: typeof row.cc_addresses === "string" ? JSON.parse(row.cc_addresses) : row.cc_addresses,
        bcc: typeof row.bcc_addresses === "string" ? JSON.parse(row.bcc_addresses) : row.bcc_addresses,
        subject: row.subject,
        body: signature.data.body,
        format: row.body_format,
        priority: row.priority,
        requestDeliveryReceipt: row.request_delivery_receipt,
        requestReadReceipt: row.request_read_receipt,
      });
      const valid = await validateContent(content, { ...row, signature_template_id: signature.data.signatureTemplateId });
      if (!valid.ok) return valid;
      const doc = createDraftDocument(content);
      try {
        state = Y.encodeStateAsUpdate(doc);
      } finally {
        doc.destroy();
      }
    } catch {
      return conflict("Legacy draft cannot be seeded without recovery");
    }
    // A failed first admission may have published before SQL rolled back its
    // deterministic seed. Rebuild that exact baseline and replay from zero,
    // never skip those retained updates by anchoring at today's head.
    const topic = mailDraftDocumentLog.topic();
    const cursor = (await topic.latestCursor({ tenantId: draftId })) ? topic.cursorAt(0) : await topic.head();
    const sequence = topic.cursorSequence(cursor);
    await db`
      UPDATE mail.drafts SET doc_state = ${Buffer.from(state)}, doc_cursor = ${cursor}, doc_seq = ${sequence},
        body_markdown = ${signature.data.body}, signature_template_id = ${signature.data.signatureTemplateId}::uuid
      WHERE id = ${draftId}::uuid
    `;
    await db`
      INSERT INTO mail.draft_document_revisions (draft_id, generation, revision, state, cursor)
      VALUES (${draftId}::uuid, ${generation}::bigint, ${Number(row.revision)}, ${Buffer.from(state)}, ${cursor})
    `;
    row = {
      ...row,
      doc_state: state,
      doc_cursor: cursor,
      doc_seq: sequence,
      body_markdown: signature.data.body,
      signature_template_id: signature.data.signatureTemplateId,
      signature_short_id: signatureShortId,
    };
  }

  const store: SharedTextStore<DraftDocumentSave, undefined> = {
    async load(docId, options) {
      options.signal?.throwIfAborted();
      if (docId !== draftId) throw new Error("Transaction-bound draft store cannot access another draft");
      const current = await loadRow();
      if (!current || current.edit_mode !== "shared") return null;
      row = current;
      if (String(row.doc_generation) !== generation) throw new Error("Draft document generation changed");
      if (!row.doc_state) throw new Error("Draft document snapshot is missing");
      return { state: row.doc_state, cursor: row.doc_cursor, restoreRevision: String(row.doc_generation), text: row.body_markdown };
    },
    async save(docId, input) {
      if (docId !== draftId) throw new Error("Transaction-bound draft store cannot access another draft");
      const ready = await assertWritable(input.restoreRevision);
      if (!ready.ok) throw new Error(ready.error.message);
      const sequence = mailDraftDocumentLog.topic().cursorSequence(input.cursor);
      if (row.doc_cursor && mailDraftDocumentLog.topic().cursorSequence(row.doc_cursor) !== Number(row.doc_seq))
        throw new Error("Stored draft cursor and sequence disagree");
      if (row.doc_seq !== null && sequence <= Number(row.doc_seq))
        return { status: "covered", revision: Number(row.revision), durable: snapshot(row) };
      const content = decode(input.state);
      if (content.body !== input.text) throw new Error("Draft body projection differs from document");
      const valid = await validateContent(content, row);
      if (!valid.ok) throw new Error(valid.error.message);
      const [updated] = await db<{ revision: string | number }[]>`
        UPDATE mail.drafts SET
          sender_identity_id = ${valid.data.senderIdentityId}::uuid,
          signature_template_id = ${valid.data.signatureTemplateId}::uuid,
          to_addresses = ${content.to}::jsonb, cc_addresses = ${content.cc}::jsonb, bcc_addresses = ${content.bcc}::jsonb,
          subject = ${content.subject}, body_markdown = ${content.body}, body_format = ${content.format},
          priority = ${content.priority}, request_delivery_receipt = ${content.requestDeliveryReceipt},
          request_read_receipt = ${content.requestReadReceipt},
          doc_state = ${Buffer.from(input.state)}, doc_cursor = ${input.cursor}, doc_seq = ${sequence},
          last_editor_kind = ${actor.kind}, last_editor_id = ${actor.id}::uuid, revision = revision + 1
        WHERE id = ${draftId}::uuid AND mailbox_id = ${mailboxId}::uuid AND origin = 'user'
          AND edit_mode = 'shared' AND state = 'draft' AND doc_frozen_cursor IS NULL
          AND doc_generation = ${input.restoreRevision}::bigint AND doc_history_complete
          AND (doc_seq IS NULL OR doc_seq < ${sequence})
        RETURNING revision
      `;
      if (!updated) throw new Error("Draft document save lost its database fence");
      await db`
        INSERT INTO mail.draft_document_revisions (draft_id, generation, revision, state, cursor)
        VALUES (${draftId}::uuid, ${input.restoreRevision}::bigint, ${Number(updated.revision)}, ${Buffer.from(input.state)}, ${input.cursor})
      `;
      await queueDraftProjectionInTransaction({ db, draftId });
      row = {
        ...row,
        doc_state: input.state,
        doc_cursor: input.cursor,
        doc_seq: sequence,
        revision: updated.revision,
        sender_identity_id: valid.data.senderIdentityId,
        signature_template_id: valid.data.signatureTemplateId,
        body_markdown: content.body,
      };
      return { status: "saved", revision: Number(updated.revision), durable: { state: input.state, cursor: input.cursor, content } };
    },
  };
  const bound = mailDraftDocumentLog.withStore(store);
  const persistSnapshot = async (state: Uint8Array, cursor: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    return store.save(
      draftId,
      {
        state,
        cursor,
        text: decode(state).body,
        restoreRevision: generation,
        requestedAt: Date.now(),
        actor,
        contributors: [],
      },
      undefined,
    );
  };

  const acceptUpdate = async (input: AcceptInput, revisionBase?: number): Promise<Result<DraftDocumentAdmission>> => {
    const ready = await assertWritable(input.generation);
    if (!ready.ok) return ready;
    if (input.generation !== generation) return recovery("Draft generation changed; retain the submitted content for recovery");
    // Raw bytes larger than the entire event budget cannot possibly fit.
    // Reject them before Yjs allocates decoded structures; Sync checks the
    // exact base64 envelope and metadata at publication.
    if (input.update.byteLength > MAX_LOG_ENVELOPE_BYTES) return recovery("Draft update exceeds the document log payload budget");
    let invalid: string | null = null;
    const admitted = await bound.accept(draftId, {
      actor,
      update: input.update,
      baseCursor: input.baseCursor,
      restoreRevision: input.generation,
      originNodeId:
        revisionBase !== undefined
          ? DRAFT_REVISION_OPERATION_ORIGIN
          : input.originNodeId === DRAFT_REVISION_OPERATION_ORIGIN
            ? sharedTextNodeId
            : (input.originNodeId ?? sharedTextNodeId),
      originPeerId: revisionBase !== undefined ? String(revisionBase) : (input.originPeerId ?? null),
      signal: input.signal ?? params.signal,
      maxLength: draftEditableContentInputSchema.shape.body.unwrap().maxLength ?? undefined,
      validateState: async (state) => {
        let content: DraftEditableContent;
        try {
          content = decode(state);
        } catch {
          invalid = "Merged draft content is invalid";
          return false;
        }
        const valid = await validateContent(content, row);
        if (!valid.ok) invalid = valid.error.message;
        return valid.ok;
      },
      validate: async () => (await assertWritable(input.generation)).ok,
    });
    if (admitted.status !== "accepted") return recovery(invalid ?? "Draft update requires recovery; retain the submitted content");
    publishedCursor = admitted.cursor;
    try {
      // Read all types, not only the body. The row lock prevents another Mail
      // admission/freeze from publishing before this snapshot is committed.
      const fresh = await bound.read(draftId, { signal: input.signal ?? params.signal });
      if (!fresh?.state || fresh.cursor !== admitted.cursor) throw new Error("Accepted draft cursor could not be reconstructed exactly");
      const saved = await persistSnapshot(fresh.state, admitted.cursor, input.signal ?? params.signal);
      return ok({ status: "accepted", cursor: admitted.cursor, revision: saved.revision, durable: saved.durable });
    } catch {
      return ok({
        status: "pendingPersistence",
        cursor: admitted.cursor,
        message: "Update is published but not durably projected; retain pending input and retry the authorized read",
      });
    }
  };

  const handle: LockedDraftDocument = {
    get generation() {
      return generation;
    },
    get revision() {
      return Number(row.revision);
    },
    get publishedCursor() {
      return publishedCursor;
    },
    store,
    async read() {
      params.signal?.throwIfAborted();
      const currentAccess = await requireDraftAccess(context, mailboxId, draftId, "read", db);
      if (!currentAccess.ok) return currentAccess;
      const fresh = await bound.read(draftId, { signal: params.signal });
      if (!fresh?.state) return fail(err.notFound("Draft document"));
      return ok({
        generation,
        revision: Number(row.revision),
        lifecycle: row.state,
        historyComplete: row.doc_history_complete,
        fresh: { state: fresh.state, cursor: fresh.cursor, content: decode(fresh.state) },
        durable: snapshot(row),
        frozen:
          row.doc_frozen_state && row.doc_frozen_cursor && row.doc_frozen_generation !== null && row.doc_frozen_revision !== null
            ? {
                state: row.doc_frozen_state,
                cursor: row.doc_frozen_cursor,
                generation: String(row.doc_frozen_generation),
                revision: Number(row.doc_frozen_revision),
              }
            : null,
      });
    },
    async project() {
      const ready = await assertWritable(generation);
      if (!ready.ok) return ready;
      const fresh = await bound.read(draftId, { signal: params.signal });
      if (!fresh?.state || !fresh.cursor) return fail(err.notFound("Draft document"));
      return ok(await persistSnapshot(fresh.state, fresh.cursor, params.signal));
    },
    async recordRevisionBase() {
      const ready = await assertWritable(generation);
      if (!ready.ok) return ready;
      const current = snapshot(row);
      const projected = draftEditableContentInputSchema.safeParse({
        senderIdentityId: row.sender_short_id,
        signatureTemplateId: row.signature_template_id === null ? null : row.signature_short_id,
        to: typeof row.to_addresses === "string" ? JSON.parse(row.to_addresses) : row.to_addresses,
        cc: typeof row.cc_addresses === "string" ? JSON.parse(row.cc_addresses) : row.cc_addresses,
        bcc: typeof row.bcc_addresses === "string" ? JSON.parse(row.bcc_addresses) : row.bcc_addresses,
        subject: row.subject,
        body: row.body_markdown,
        format: row.body_format,
        priority: row.priority,
        requestDeliveryReceipt: row.request_delivery_receipt,
        requestReadReceipt: row.request_read_receipt,
      });
      if (
        !projected.success ||
        JSON.stringify(normalizeDraftDocumentContent(projected.data)) !== JSON.stringify(normalizeDraftDocumentContent(current.content))
      )
        return conflict("SQL content differs from its document; cannot authenticate this revision base");
      await db`
        INSERT INTO mail.draft_document_revisions (draft_id, generation, revision, state, cursor)
        VALUES (${draftId}::uuid, ${generation}::bigint, ${Number(row.revision)}, ${Buffer.from(current.state)}, ${current.cursor})
        ON CONFLICT (draft_id, generation, revision) DO NOTHING
      `;
      const [exact] = await db<{ matches: boolean }[]>`
        SELECT state = ${Buffer.from(current.state)} AND cursor IS NOT DISTINCT FROM ${current.cursor} AS matches
        FROM mail.draft_document_revisions
        WHERE draft_id = ${draftId}::uuid AND generation = ${generation}::bigint AND revision = ${Number(row.revision)}
      `;
      return exact?.matches
        ? ok({ revision: Number(row.revision), cursor: current.cursor })
        : conflict("Draft revision already names a different authenticated base");
    },
    accept: (input) => acceptUpdate(input),
    async writeRevision(input) {
      const ready = await assertWritable(input.generation);
      if (!ready.ok) return ready;
      if (input.generation !== generation || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
        return recovery("Draft revision or generation requires recovery");
      const [base] = await db<{ state: Uint8Array; cursor: string | null }[]>`
        SELECT state, cursor FROM mail.draft_document_revisions
        WHERE draft_id = ${draftId}::uuid AND generation = ${input.generation}::bigint AND revision = ${input.expectedRevision}
      `;
      if (!base) return recovery("Authenticated draft revision base is unavailable");
      const signal = input.signal ?? params.signal;
      const remaining = input.deadline - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) return recovery("Draft revision edit exceeded its request budget");
      const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.ceil(remaining))]);
      let content: DraftEditableContent;
      let receipt: Awaited<ReturnType<typeof findDraftRevisionOperation>>;
      try {
        content = draftRevisionOperationContent(base.state, input.content);
        const topic = mailDraftDocumentLog.topic();
        // Use the GLOBAL head even when this tenant has no retained events.
        // Otherwise a removed receipt could look like an operation never sent.
        const until = await topic.head();
        receipt = await findDraftRevisionOperation({
          base: base.state,
          content,
          actor,
          generation: input.generation,
          expectedRevision: input.expectedRevision,
          events: topic.replay({ tenantId: draftId, after: base.cursor ?? topic.cursorAt(0), until, signal: requestSignal }),
          deadline: input.deadline,
          signal: requestSignal,
        });
      } catch {
        return recovery("Draft revision operation history is unavailable; retain the submitted content for recovery");
      }
      if (receipt) {
        // Its exact delta is already published. Project today's complete state,
        // including distinct peers, without running ingress again on old text.
        publishedCursor = receipt.cursor;
        try {
          const fresh = await bound.read(draftId, { signal: requestSignal });
          if (!fresh?.state || !fresh.cursor) throw new Error("Published revision cannot be reconstructed");
          const saved = await persistSnapshot(fresh.state, fresh.cursor, requestSignal);
          return ok({ status: "accepted", cursor: fresh.cursor, revision: saved.revision, durable: saved.durable });
        } catch {
          return ok({
            status: "pendingPersistence",
            cursor: receipt.cursor,
            message: "Revision operation is published but not durably projected; retain pending input and retry the authorized read",
          });
        }
      }
      let update: Uint8Array;
      try {
        update = await createDraftRevisionUpdate(base.state, content, { deadline: input.deadline, signal: requestSignal });
      } catch {
        return recovery("Draft revision edit could not be merged within its request budget");
      }
      return acceptUpdate({ update, baseCursor: base.cursor, generation: input.generation, signal: requestSignal }, input.expectedRevision);
    },
    async freeze(input) {
      const ready = await assertWritable(input.generation);
      if (!ready.ok) return ready;
      if (input.generation !== generation) return conflict("Draft generation changed before freeze");
      const frozen = await bound.freeze(draftId, {
        actor,
        restoreRevision: input.generation,
        signal: input.signal ?? params.signal,
        validate: async (state) => {
          const content = decode(state);
          if (content.format === "markdown") {
            const table = inspectTableStructure(content.body);
            if (table.extraCells || table.missingSeparator) throw new Error("Draft tables require review before freezing");
          }
          const valid = await validateContent(content, row);
          if (!valid.ok) throw new Error(valid.error.message);
        },
      });
      if (!frozen) return fail(err.notFound("Draft document"));
      publishedCursor = frozen.cursor;
      // Throws after a marker if persistence fails. The send caller MUST roll
      // back; an unreferenced marker has no lifecycle effect.
      const saved = await persistSnapshot(frozen.state, frozen.cursor, input.signal ?? params.signal);
      await db`
        UPDATE mail.drafts SET doc_frozen_cursor = ${frozen.cursor}, doc_frozen_state = ${Buffer.from(frozen.state)},
          doc_frozen_generation = ${generation}::bigint, doc_frozen_revision = ${saved.revision}
        WHERE id = ${draftId}::uuid AND doc_generation = ${generation}::bigint AND state = 'draft' AND edit_mode = 'shared'
      `;
      row = {
        ...row,
        doc_frozen_cursor: frozen.cursor,
        doc_frozen_state: frozen.state,
        doc_frozen_generation: generation,
        doc_frozen_revision: saved.revision,
      };
      return ok({ state: frozen.state, cursor: frozen.cursor, generation, revision: saved.revision, content: decode(frozen.state) });
    },
  };
  return ok(handle);
};

export const readDraftDocument = async (params: Target): Promise<Result<DraftDocumentRead>> => {
  try {
    return await withDraftDocumentTransaction(params.signal, async (db) => {
      const locked = await lockDraftDocumentInTransaction({ ...params, db, permission: "read" });
      return locked.ok ? locked.data.read() : locked;
    });
  } catch {
    return fail(err.conflict("Draft document cannot be read completely; retry or recover pending content"));
  }
};

export const acceptDraftDocumentUpdate = async (params: Target & AcceptInput): Promise<Result<DraftDocumentAdmission>> => {
  const outcome: { admitted: DraftDocumentAdmission | null } = { admitted: null };
  try {
    return await withDraftDocumentTransaction(params.signal, async (db) => {
      const locked = await lockDraftDocumentInTransaction({ ...params, db });
      if (!locked.ok) return locked;
      const result = await locked.data.accept(params);
      if (result.ok) outcome.admitted = result.data;
      return result;
    });
  } catch (error) {
    if (outcome.admitted && outcome.admitted.status !== "recoveryRequired")
      return ok({
        status: "pendingPersistence",
        cursor: outcome.admitted.cursor,
        message: "Update is published but the database commit failed; retain pending input and retry the authorized read",
      });
    if (error instanceof ConflictError) return recovery("Draft changed concurrently; refresh and retry with the original input");
    // Unknown broker/database failures may include a lost acknowledgement.
    // Transport reconnects with the same original Yjs bytes; it must not
    // misclassify a temporary outage as a permanently closed generation.
    throw error;
  }
};
