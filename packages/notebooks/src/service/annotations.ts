import { env } from "@k2b/cloud/config";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { hasPermission } from "@k2b/cloud/server";
import { SHARED_TEXT_NAME } from "@k2b/cloud/shared-text";
import { err, fail, i18n, ok, type Result } from "@k2b/stdlib";
import { SQL, sql, type TransactionSQL } from "bun";
import * as Y from "yjs";
import type { z } from "zod";
import {
  absoluteAnnotationPosition,
  annotationContext,
  annotationHeadingPath,
  annotationPositions,
  locateAnnotation,
  resolveAnnotation,
} from "../lib/annotation-anchors";
import {
  ANNOTATION_PAGE_SIZE,
  ANNOTATION_QUOTE_MAX_LENGTH,
  type Annotation,
  AnnotationCreateSchema,
  AnnotationEditSchema,
  AnnotationIdSchema,
  AnnotationOperationSchema,
  AnnotationPageSchema,
  type AnnotationProjection,
  AnnotationReplySchema,
} from "../lib/annotation-contracts";
import { noteContentHash } from "../lib/note-edit";
import { getNotebookPermission } from "./access";
import * as activity from "./activity";
import { resolveNotebookApiKeyPermission } from "./api-key-permissions";
import { COMMENT_MUTATION_WINDOW_MS } from "./comments";
import * as notes from "./notes";
import * as workspaceEvents from "./workspace-events";

export type AnnotationContext = Pick<CapabilityExecutionContext, "actor" | "accessSubject" | "locale" | "requestId" | "signal"> &
  Partial<Pick<CapabilityExecutionContext, "origin" | "authority">>;
const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      unavailable: "Note or comment not found",
      write: "Write access is required",
      invalid: "Check the comment input",
      passage: "The passage is missing or ambiguous. Select it again.",
      key: "This idempotency key was used with different content",
      own: "Only the author may change this comment within ten minutes",
      replies: "A comment with replies cannot be deleted",
      locked: "Unlock the note before accepting or undoing a suggestion",
      open: "Only an open comment with a suggestion can be accepted",
      accepted: "This comment has no accepted suggestion to undo",
      changed: "The text has changed since this suggestion was made",
      operation: "This operation ID belongs to another request",
      pending: "Another suggestion operation is pending. Retry its operation ID.",
      retry: "The suggestion could not be saved. Retry with the same operation ID.",
      cursor: "Invalid comment cursor",
      busy: "Comments are being updated. Retry this request.",
    },
    de: {
      unavailable: "Notiz oder Kommentar nicht gefunden",
      write: "Schreibzugriff ist erforderlich",
      invalid: "Bitte die Kommentareingabe prüfen",
      passage: "Die Textstelle fehlt oder ist nicht eindeutig. Bitte erneut auswählen.",
      key: "Dieser Idempotenzschlüssel wurde mit anderem Inhalt verwendet",
      own: "Nur der Autor kann diesen Kommentar innerhalb von zehn Minuten ändern",
      replies: "Ein Kommentar mit Antworten kann nicht gelöscht werden",
      locked: "Bitte die Notiz entsperren, bevor ein Vorschlag übernommen oder rückgängig gemacht wird",
      open: "Nur ein offener Kommentar mit Vorschlag kann übernommen werden",
      accepted: "Dieser Kommentar hat keinen übernommenen Vorschlag zum Rückgängigmachen",
      changed: "Der Text wurde inzwischen geändert",
      operation: "Diese Vorgangs-ID gehört zu einer anderen Anfrage",
      pending: "Ein anderer Vorschlagsvorgang ist offen. Bitte dessen Vorgangs-ID erneut verwenden.",
      retry: "Der Vorschlag konnte nicht gespeichert werden. Bitte mit derselben Vorgangs-ID erneut versuchen.",
      cursor: "Ungültiger Kommentar-Cursor",
      busy: "Kommentare werden gerade aktualisiert. Bitte erneut versuchen.",
    },
  },
});
const words = (context: AnnotationContext) => messages.resolve([context.locale]).t;
const actor = (context: AnnotationContext) =>
  context.actor.kind === "user"
    ? {
        kind: "user" as const,
        id: context.actor.user.id,
        name: context.actor.user.displayName ?? context.actor.user.uid,
        avatarHash: context.actor.user.avatarHash,
      }
    : { kind: "service_account" as const, id: context.actor.serviceAccount.id, name: context.actor.serviceAccount.name, avatarHash: null };
const via = (context: AnnotationContext) => (context.origin === "assistant" || context.origin === "mcp" ? context.origin : null);
const conflict = (message: string, details?: Record<string, unknown>): Result<never> =>
  fail({ code: "CONFLICT", message, status: 409, ...(details ? { details } : {}) });
const conflictData = (operationId: string, value: string | null) => {
  const text = value ?? "";
  let end = ANNOTATION_QUOTE_MAX_LENGTH;
  if (text.length > end && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return {
    operationId,
    currentText: text.slice(0, end),
    ...(text.length > end ? { currentTextTruncated: true, currentTextLength: text.length } : {}),
  };
};
const notFound = (context: AnnotationContext): Result<never> =>
  fail({ code: "NOT_FOUND", message: words(context).unavailable, status: 404 });

export const authorize = async (noteId: string, context: AnnotationContext, write = false) => {
  context.signal.throwIfAborted();
  const note = await notes.getByShortId({ shortId: noteId });
  if (!note) return notFound(context);
  const subject = context.accessSubject;
  if (context.actor.kind === "service_account") {
    const account = context.actor.serviceAccount;
    if (
      account.kind === "resource_bound" &&
      (account.appId !== "notebooks" || account.resourceType !== "notebook" || account.resourceId !== note.notebookId)
    )
      return notFound(context);
    if (
      account.kind === "user_delegated"
        ? subject.type !== "user"
        : subject.type !== "service_account" || subject.serviceAccountId !== account.id
    )
      return notFound(context);
  } else if (subject.type !== "user" || subject.userId !== context.actor.user.id) return notFound(context);
  let permission = await getNotebookPermission({
    notebookId: note.notebookId,
    userId: subject.type === "user" ? subject.userId : null,
    serviceAccountId: subject.type === "service_account" ? subject.serviceAccountId : null,
  });
  if (context.actor.kind === "service_account" && context.actor.serviceAccount.kind !== "user_delegated")
    permission = resolveNotebookApiKeyPermission(permission, context.actor.scopes);
  if (!hasPermission(permission, "read")) return notFound(context);
  if (write && !hasPermission(permission, "write")) return fail(err.forbidden(words(context).write));
  return ok({ note, canWrite: hasPermission(permission, "write") });
};

type RootRow = {
  id: string;
  note_id: string;
  start_rel: Uint8Array;
  end_rel: Uint8Array;
  restore_revision: string;
  quote: string;
  prefix: string;
  suffix: string;
  body: string;
  suggestion: string | null;
  state: "open" | "resolved" | "accepted";
  state_by_kind: "user" | "service_account" | null;
  state_by_id: string | null;
  state_by_name: string | null;
  state_at: Date | null;
  author_kind: "user" | "service_account";
  author_id: string;
  author_name: string;
  author_avatar_hash: string | null;
  via: "assistant" | "mcp" | null;
  created_at: Date;
  cursor_at: string;
  updated_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
  payload_hash: string;
};
type ReplyRow = Pick<
  RootRow,
  | "id"
  | "body"
  | "author_kind"
  | "author_id"
  | "author_name"
  | "author_avatar_hash"
  | "via"
  | "created_at"
  | "cursor_at"
  | "edited_at"
  | "deleted_at"
  | "payload_hash"
>;
type OperationRow = {
  id: string;
  annotation_id: string;
  kind: "accept" | "undo";
  expected_text: string;
  before_text: string;
  after_text: string;
  source_start_rel: Uint8Array;
  source_end_rel: Uint8Array;
  start_rel: Uint8Array | null;
  end_rel: Uint8Array | null;
  prepared_update: Uint8Array | null;
  restore_revision: string;
  status: "pending" | "applied" | "conflict" | "failed";
  current_text: string | null;
  actor_kind: "user" | "service_account";
  actor_id: string;
};
const mutable = (row: ReplyRow, context: AnnotationContext, canWrite: boolean) => {
  const identity = actor(context);
  return (
    canWrite &&
    row.author_kind === identity.kind &&
    row.author_id === identity.id &&
    Date.now() - row.created_at.getTime() <= COMMENT_MUTATION_WINDOW_MS
  );
};
const person = (row: ReplyRow) => ({ kind: row.author_kind, id: row.author_id, name: row.author_name, avatarHash: row.author_avatar_hash });
const mapReply = (row: ReplyRow, context: AnnotationContext, canWrite: boolean) => ({
  id: row.id,
  body: row.body,
  author: person(row),
  via: row.via,
  createdAt: row.created_at.toISOString(),
  editedAt: row.edited_at?.toISOString() ?? null,
  canEdit: !row.deleted_at && mutable(row, context, canWrite),
  canDelete: !row.deleted_at && mutable(row, context, canWrite),
});
// One dedicated transaction connection per process keeps annotation coordination
// from consuming the shared pool that the document store needs while saving.
let transactionPool: SQL | undefined;
const annotationTransactions = () => (transactionPool ??= new SQL({ url: env.DATABASE_URL, max: 1 }));
export const close = async () => {
  const pool = transactionPool;
  transactionPool = undefined;
  await pool?.close();
};
const withNoteLock = <T>(noteId: string, context: AnnotationContext, run: (tx: TransactionSQL) => Promise<Result<T>>): Promise<Result<T>> =>
  annotationTransactions().begin(async (tx) => {
    context.signal.throwIfAborted();
    // Serialize across replicas without waiting connections exhausting the pool:
    // the text store needs its own SQL connection to save a prepared operation.
    const [lock] = await tx<
      { acquired: boolean }[]
    >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`notebooks.annotations:${noteId}`}, 0)) AS acquired`;
    if (!lock?.acquired) return conflict(words(context).busy);
    return run(tx);
  });
const loadRoot = async (noteId: string, id: string) => {
  const [row] = await sql<
    RootRow[]
  >`SELECT *, created_at::text AS cursor_at, restore_revision::text FROM notebooks.annotations WHERE note_id = ${noteId}::uuid AND id = ${id}::uuid`;
  return row ?? null;
};
const loadHead = async (noteId: string, context: AnnotationContext) => {
  const stored = await notes.getAnchoredYjsState({ noteId, signal: context.signal });
  const head = await notes.noteDocuments.read(noteId, { signal: context.signal });
  const revision = await notes.getYjsStateWithCursor({ noteId });
  if (!head || !stored || !revision) throw new Error("Note disappeared while reading comments");
  if (revision.restoreRevision !== stored.restoreRevision) throw new Error("Note was restored while reading comments; retry");
  const doc = new Y.Doc();
  if (head.state) Y.applyUpdate(doc, head.state);
  return { doc, text: doc.getText(SHARED_TEXT_NAME).toString(), cursor: head.cursor, restoreRevision: revision.restoreRevision };
};
const projectRoot = async (
  row: RootRow,
  head: Awaited<ReturnType<typeof loadHead>>,
  noteId: string,
  context: AnnotationContext,
  canWrite: boolean,
): Promise<Annotation> => {
  const range = resolveAnnotation({
    doc: head.doc,
    start: row.start_rel,
    end: row.end_rel,
    selector: row,
    sameRevision: row.restore_revision === head.restoreRevision,
  });
  let positions = { start: row.start_rel, end: row.end_rel };
  if (range.reanchored) {
    positions = annotationPositions(head.doc, range.from, range.to);
    await sql`UPDATE notebooks.annotations SET start_rel = ${Buffer.from(positions.start)}, end_rel = ${Buffer.from(positions.end)}, restore_revision = ${head.restoreRevision}::bigint
      WHERE id = ${row.id}::uuid AND start_rel = ${Buffer.from(row.start_rel)} AND end_rel = ${Buffer.from(row.end_rel)} AND restore_revision = ${row.restore_revision}::bigint`;
  }
  const replies = await sql<
    ReplyRow[]
  >`SELECT *, created_at::text AS cursor_at FROM notebooks.annotation_replies WHERE annotation_id = ${row.id}::uuid AND deleted_at IS NULL ORDER BY created_at, id LIMIT ${ANNOTATION_PAGE_SIZE + 1}`;
  const [accepted] = await sql<
    { id: string }[]
  >`SELECT id FROM notebooks.annotation_operations WHERE annotation_id = ${row.id}::uuid AND kind = 'accept' AND status = 'applied' ORDER BY created_at DESC, id DESC LIMIT 1`;
  const visible = replies.slice(0, ANNOTATION_PAGE_SIZE);
  while (visible.length > 1 && bytes(visible.map((reply) => mapReply(reply, context, canWrite))) > DATA_BUDGET / 3) visible.pop();
  return {
    id: row.id,
    noteId,
    from: range.from,
    to: range.to,
    orphan: range.orphan,
    startRel: Buffer.from(positions.start).toString("base64"),
    endRel: Buffer.from(positions.end).toString("base64"),
    restoreRevision: range.reanchored ? head.restoreRevision : row.restore_revision,
    quote: row.quote,
    prefix: row.prefix,
    suffix: row.suffix,
    body: row.body,
    suggestion: row.suggestion,
    state: row.state,
    stateBy: row.state_by_kind && row.state_by_id ? { kind: row.state_by_kind, id: row.state_by_id, name: row.state_by_name ?? "" } : null,
    stateAt: row.state_at?.toISOString() ?? null,
    author: person(row),
    via: row.via,
    createdAt: row.created_at.toISOString(),
    editedAt: row.edited_at?.toISOString() ?? null,
    canEdit: !row.deleted_at && mutable(row, context, canWrite),
    canDelete: !row.deleted_at && mutable(row, context, canWrite) && replies.length === 0,
    replies: visible.map((reply) => mapReply(reply, context, canWrite)),
    repliesNextCursor: replies.length > visible.length ? encodeCursor(visible[visible.length - 1]!) : null,
    headingPath: annotationHeadingPath(head.text, range.from),
    acceptedOperationId: row.state === "accepted" ? (accepted?.id ?? null) : null,
  };
};
type Cursor = { at: string; id: string };
const encodeCursor = (row: { cursor_at: string; id: string }) =>
  Buffer.from(JSON.stringify({ at: row.cursor_at, id: row.id })).toString("base64url");
const decodeCursor = (value: string | undefined): Cursor | null => {
  if (!value) return null;
  try {
    const cursor: unknown = JSON.parse(Buffer.from(value, "base64url").toString());
    if (
      typeof cursor === "object" &&
      cursor !== null &&
      "at" in cursor &&
      typeof cursor.at === "string" &&
      Number.isFinite(Date.parse(cursor.at)) &&
      "id" in cursor &&
      AnnotationIdSchema.safeParse(cursor.id).success
    )
      return cursor as Cursor;
  } catch {
    /* invalid cursor is reported at the boundary */
  }
  throw new Error("Invalid cursor");
};
// Reserve six KiB of the 256 KiB capability envelope for page metadata
// and the resource refs added to at most 30 list items.
const DATA_BUDGET = 250 * 1024;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

export const list = async (
  noteId: string,
  input: z.input<typeof AnnotationPageSchema>,
  context: AnnotationContext,
  options: { compact?: boolean } = {},
): Promise<Result<AnnotationProjection>> => {
  const parsed = AnnotationPageSchema.safeParse(input);
  if (!parsed.success) return fail(err.badInput(words(context).invalid));
  const access = await authorize(noteId, context);
  if (!access.ok) return access;
  let cursor: Cursor | null;
  try {
    cursor = decodeCursor(parsed.data.cursor);
  } catch {
    return fail(err.badInput(words(context).cursor));
  }
  return withNoteLock(access.data.note.id, context, async () => {
    const head = await loadHead(access.data.note.id, context);
    try {
      const rows = await sql<RootRow[]>`SELECT *, created_at::text AS cursor_at, restore_revision::text FROM notebooks.annotations
        WHERE note_id = ${access.data.note.id}::uuid AND deleted_at IS NULL
          AND (${cursor?.at ?? null}::timestamptz IS NULL OR (created_at, id) > (${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
        ORDER BY created_at, id LIMIT ${parsed.data.limit + 1}`;
      const projection: AnnotationProjection = {
        text: options.compact ? "" : head.text,
        contentHash: noteContentHash(head.text),
        cursor: head.cursor,
        restoreRevision: head.restoreRevision,
        items: [],
        nextCursor: null,
      };
      for (const row of rows.slice(0, parsed.data.limit)) {
        context.signal.throwIfAborted();
        const item = await projectRoot(row, head, noteId, context, access.data.canWrite);
        if (projection.items.length && bytes([...projection.items, item]) > DATA_BUDGET) break;
        projection.items.push(item);
      }
      if (projection.items.length < rows.length) {
        const last = rows[projection.items.length - 1];
        if (last) projection.nextCursor = encodeCursor(last);
      }
      return ok(projection);
    } finally {
      head.doc.destroy();
    }
  });
};
export const read = async (noteId: string, id: string, context: AnnotationContext) => {
  if (!AnnotationIdSchema.safeParse(id).success) return notFound(context);
  const access = await authorize(noteId, context);
  if (!access.ok) return access;
  return withNoteLock(access.data.note.id, context, async () => {
    const row = await loadRoot(access.data.note.id, id);
    if (!row || row.deleted_at) return notFound(context);
    const head = await loadHead(access.data.note.id, context);
    try {
      return ok(await projectRoot(row, head, noteId, context, access.data.canWrite));
    } finally {
      head.doc.destroy();
    }
  });
};
export const readResource = async (id: string, context: AnnotationContext) => {
  if (!AnnotationIdSchema.safeParse(id).success) return notFound(context);
  const [row] = await sql<
    { short_id: string }[]
  >`SELECT note.short_id FROM notebooks.annotations annotation JOIN notebooks.notes note ON note.id = annotation.note_id WHERE annotation.id = ${id}::uuid`;
  return row ? read(row.short_id, id, context) : notFound(context);
};
const changed = async (note: notes.Note) => {
  // Every write opportunistically purges one bounded page after the original
  // author mutation window, without introducing another worker or schedule.
  const expiredBefore = new Date(Date.now() - COMMENT_MUTATION_WINDOW_MS);
  await sql`DELETE FROM notebooks.annotation_replies WHERE id IN (
    SELECT reply.id FROM notebooks.annotation_replies reply JOIN notebooks.annotations root ON root.id = reply.annotation_id
    WHERE root.note_id = ${note.id}::uuid AND reply.deleted_at IS NOT NULL AND reply.created_at < ${expiredBefore} LIMIT ${ANNOTATION_PAGE_SIZE}
  )`;
  await sql`DELETE FROM notebooks.annotations WHERE id IN (
    SELECT id FROM notebooks.annotations WHERE note_id = ${note.id}::uuid AND deleted_at IS NOT NULL AND created_at < ${expiredBefore} LIMIT ${ANNOTATION_PAGE_SIZE}
  )`;
  await workspaceEvents.noteCommentsChanged({ notebookId: note.notebookId, noteId: note.id });
};
export const create = async (noteId: string, input: z.input<typeof AnnotationCreateSchema>, context: AnnotationContext) => {
  const parsed = AnnotationCreateSchema.safeParse(input);
  if (!parsed.success) return fail(err.badInput(words(context).invalid));
  const access = await authorize(noteId, context, true);
  if (!access.ok) return access;
  const identity = actor(context);
  const value = parsed.data;
  const hash = noteContentHash(JSON.stringify({ ...value, suggestion: value.suggestion ?? null }));
  const result = await withNoteLock(access.data.note.id, context, async (tx) => {
    const [existing] = await sql<
      RootRow[]
    >`SELECT *, created_at::text AS cursor_at, restore_revision::text FROM notebooks.annotations WHERE note_id = ${access.data.note.id}::uuid
      AND author_kind = ${identity.kind} AND author_id = ${identity.id}::uuid AND idempotency_key = ${value.idempotencyKey}`;
    if (existing) {
      if (existing.payload_hash !== hash) return conflict(words(context).key);
      return ok(existing.id);
    }
    const head = await loadHead(access.data.note.id, context);
    try {
      const from = locateAnnotation(head.text, value, value.offsetHint);
      if (from === null) return conflict(words(context).passage);
      const to = from + value.quote.length;
      const positions = annotationPositions(head.doc, from, to);
      const contextText = annotationContext(head.text, from, to);
      const [row] = await tx<RootRow[]>`INSERT INTO notebooks.annotations (
        note_id, start_rel, end_rel, restore_revision, quote, prefix, suffix, body, suggestion,
        author_kind, author_id, author_name, author_avatar_hash, via, idempotency_key, payload_hash, request_id
      ) VALUES (${access.data.note.id}::uuid, ${Buffer.from(positions.start)}, ${Buffer.from(positions.end)}, ${head.restoreRevision}::bigint,
        ${value.quote}, ${contextText.prefix}, ${contextText.suffix},
        ${value.body}, ${value.suggestion ?? null}, ${identity.kind}, ${identity.id}::uuid, ${identity.name}, ${identity.avatarHash}, ${via(context)}, ${value.idempotencyKey}, ${hash}, ${context.requestId}) RETURNING *, created_at::text AS cursor_at, restore_revision::text`;
      await activity.record(
        {
          notebookId: access.data.note.notebookId,
          noteId: access.data.note.id,
          actor: { kind: identity.kind, id: identity.id },
          action: "annotation.create",
          metadata: { annotationId: row!.id, requestId: context.requestId },
          occurredAt: row!.created_at,
        },
        tx,
      );
      return ok(row!.id);
    } finally {
      head.doc.destroy();
    }
  });
  if (!result.ok) return result;
  await changed(access.data.note);
  return read(noteId, result.data, context);
};
export const reply = async (noteId: string, id: string, input: z.input<typeof AnnotationReplySchema>, context: AnnotationContext) => {
  const parsed = AnnotationReplySchema.safeParse(input);
  if (!parsed.success) return fail(err.badInput(words(context).invalid));
  if (!AnnotationIdSchema.safeParse(id).success) return notFound(context);
  const access = await authorize(noteId, context, true);
  if (!access.ok) return access;
  const identity = actor(context);
  return withNoteLock(access.data.note.id, context, async () => {
    const root = await loadRoot(access.data.note.id, id);
    if (!root || root.deleted_at) return notFound(context);
    const hash = noteContentHash(parsed.data.body);
    const [existing] = await sql<
      ReplyRow[]
    >`SELECT *, created_at::text AS cursor_at FROM notebooks.annotation_replies WHERE annotation_id = ${id}::uuid AND author_kind = ${identity.kind} AND author_id = ${identity.id}::uuid AND idempotency_key = ${parsed.data.idempotencyKey}`;
    if (existing) {
      if (existing.payload_hash !== hash) return conflict(words(context).key);
      await changed(access.data.note);
      return ok(mapReply(existing, context, true));
    }
    const [row] = await sql<
      ReplyRow[]
    >`INSERT INTO notebooks.annotation_replies (annotation_id, author_kind, author_id, author_name, author_avatar_hash, via, body, idempotency_key, payload_hash, request_id)
      VALUES (${id}::uuid, ${identity.kind}, ${identity.id}::uuid, ${identity.name}, ${identity.avatarHash}, ${via(context)}, ${parsed.data.body}, ${parsed.data.idempotencyKey}, ${hash}, ${context.requestId}) RETURNING *, created_at::text AS cursor_at`;
    await changed(access.data.note);
    return ok(mapReply(row!, context, true));
  });
};
export const replies = async (noteId: string, id: string, input: z.input<typeof AnnotationPageSchema>, context: AnnotationContext) => {
  const parsed = AnnotationPageSchema.safeParse(input);
  if (!parsed.success) return fail(err.badInput(words(context).invalid));
  if (!AnnotationIdSchema.safeParse(id).success) return notFound(context);
  const access = await authorize(noteId, context);
  if (!access.ok) return access;
  let cursor: Cursor | null;
  try {
    cursor = decodeCursor(parsed.data.cursor);
  } catch {
    return fail(err.badInput(words(context).cursor));
  }
  const root = await loadRoot(access.data.note.id, id);
  if (!root || root.deleted_at) return notFound(context);
  const rows = await sql<
    ReplyRow[]
  >`SELECT *, created_at::text AS cursor_at FROM notebooks.annotation_replies WHERE annotation_id = ${id}::uuid AND deleted_at IS NULL
    AND (${cursor?.at ?? null}::timestamptz IS NULL OR (created_at, id) > (${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::uuid)) ORDER BY created_at, id LIMIT ${parsed.data.limit + 1}`;
  const visible = rows.slice(0, parsed.data.limit);
  while (visible.length > 1 && bytes(visible.map((row) => mapReply(row, context, access.data.canWrite))) > DATA_BUDGET) visible.pop();
  return ok({
    items: visible.map((row) => mapReply(row, context, access.data.canWrite)),
    nextCursor: rows.length > visible.length ? encodeCursor(visible[visible.length - 1]!) : null,
  });
};

/** Root and reply edits/deletes/restores share author, window and grant checks. */
export const mutate = async (
  noteId: string,
  id: string,
  input: {
    kind: "edit" | "delete" | "restore" | "resolve" | "reopen";
    replyId?: string;
    body?: string;
    suggestion?: string | null;
  },
  context: AnnotationContext,
) => {
  if (!AnnotationIdSchema.safeParse(id).success || (input.replyId && !AnnotationIdSchema.safeParse(input.replyId).success))
    return notFound(context);
  const access = await authorize(noteId, context, true);
  if (!access.ok) return access;
  const result = await withNoteLock(access.data.note.id, context, async () => {
    const root = await loadRoot(access.data.note.id, id);
    if (!root || (root.deleted_at && (input.kind !== "restore" || input.replyId))) return notFound(context);
    const [replyRow] = input.replyId
      ? await sql<
          ReplyRow[]
        >`SELECT *, created_at::text AS cursor_at FROM notebooks.annotation_replies WHERE id = ${input.replyId}::uuid AND annotation_id = ${id}::uuid`
      : [];
    if (input.replyId && (!replyRow || (replyRow.deleted_at && input.kind !== "restore"))) return notFound(context);
    const row = replyRow ?? root;
    if (input.kind === "resolve" || input.kind === "reopen") {
      if (input.replyId || root.state === "accepted") return conflict(words(context).accepted);
      const [pending] =
        await sql`SELECT id FROM notebooks.annotation_operations WHERE annotation_id = ${id}::uuid AND status = 'pending' LIMIT 1`;
      if (pending) return conflict(words(context).pending, { operationId: pending.id, status: "pending" });
      const identity = actor(context);
      await sql`UPDATE notebooks.annotations SET state = ${input.kind === "resolve" ? "resolved" : "open"}, state_by_kind = ${identity.kind}, state_by_id = ${identity.id}::uuid, state_by_name = ${identity.name}, state_at = now(), updated_at = now() WHERE id = ${id}::uuid`;
    } else {
      if (!mutable(row, context, true)) return fail(err.forbidden(words(context).own));
      if (input.kind === "edit") {
        const parsed = AnnotationEditSchema.safeParse({
          body: input.body,
          ...(input.suggestion !== undefined ? { suggestion: input.suggestion } : {}),
        });
        if (!parsed.success) return fail(err.badInput(words(context).invalid));
        const suggestion = input.suggestion === undefined ? root.suggestion : input.suggestion;
        if (!parsed.data.body && (replyRow || suggestion === null || suggestion === root.quote))
          return fail(err.badInput(words(context).invalid));
        if (replyRow)
          await sql`UPDATE notebooks.annotation_replies SET body = ${parsed.data.body}, edited_at = now(), updated_at = now() WHERE id = ${row.id}::uuid`;
        else {
          const [pending] =
            await sql`SELECT id FROM notebooks.annotation_operations WHERE annotation_id = ${id}::uuid AND status = 'pending' LIMIT 1`;
          if (pending && suggestion !== root.suggestion)
            return conflict(words(context).pending, { operationId: pending.id, status: "pending" });
          await sql`UPDATE notebooks.annotations SET body = ${parsed.data.body}, suggestion = ${suggestion}, edited_at = now(), updated_at = now() WHERE id = ${id}::uuid`;
        }
      } else {
        if (input.kind === "delete" && !replyRow) {
          const [replyExists] =
            await sql`SELECT id FROM notebooks.annotation_replies WHERE annotation_id = ${id}::uuid AND deleted_at IS NULL LIMIT 1`;
          if (replyExists) return conflict(words(context).replies);
          const [pending] =
            await sql`SELECT id FROM notebooks.annotation_operations WHERE annotation_id = ${id}::uuid AND status = 'pending' LIMIT 1`;
          if (pending) return conflict(words(context).pending, { operationId: pending.id, status: "pending" });
        }
        if (replyRow)
          await sql`UPDATE notebooks.annotation_replies SET deleted_at = ${input.kind === "delete" ? new Date() : null}, updated_at = now() WHERE id = ${row.id}::uuid`;
        else
          await sql`UPDATE notebooks.annotations SET deleted_at = ${input.kind === "delete" ? new Date() : null}, updated_at = now() WHERE id = ${id}::uuid`;
      }
    }
    await changed(access.data.note);
    return ok({ id: row.id, annotationId: id, deleted: input.kind === "delete" });
  });
  return result;
};

/** Approval snapshots show the exact proposed replacement, including a custom accepted source. */
export const previewOperation = async (
  noteId: string,
  id: string,
  kind: "accept" | "undo",
  expectedText: string | undefined,
  context: AnnotationContext,
) => {
  if (!AnnotationIdSchema.safeParse(id).success) return notFound(context);
  const access = await authorize(noteId, context, true);
  if (!access.ok) return access;
  const root = await loadRoot(access.data.note.id, id);
  if (!root || root.deleted_at) return notFound(context);
  if (kind === "accept") {
    if (root.state !== "open" || root.suggestion === null || root.suggestion === root.quote) return conflict(words(context).open);
    return ok({ before: expectedText ?? root.quote, after: root.suggestion });
  }
  if (root.state !== "accepted") return conflict(words(context).accepted);
  const [accepted] = await sql<OperationRow[]>`SELECT * FROM notebooks.annotation_operations
    WHERE annotation_id = ${id}::uuid AND kind = 'accept' AND status = 'applied'
    ORDER BY created_at DESC, id DESC LIMIT 1`;
  return accepted ? ok({ before: accepted.after_text, after: accepted.before_text }) : conflict(words(context).accepted);
};

class OperationConflict extends Error {
  constructor(readonly currentText: string) {
    super("Suggestion conflict");
  }
}
export const operate = async (
  noteId: string,
  id: string,
  kind: "accept" | "undo",
  input: z.input<typeof AnnotationOperationSchema>,
  context: AnnotationContext,
) => {
  const parsed = AnnotationOperationSchema.safeParse(input);
  if (!parsed.success) return fail(err.badInput(words(context).invalid));
  if (!AnnotationIdSchema.safeParse(id).success) return notFound(context);
  const access = await authorize(noteId, context, true);
  if (!access.ok) return access;
  const identity = actor(context);
  return withNoteLock(access.data.note.id, context, async () => {
    const root = await loadRoot(access.data.note.id, id);
    if (!root || root.deleted_at) return notFound(context);
    // Recheck lock inside the serialization boundary, including retries.
    const fresh = await notes.get({ id: access.data.note.id });
    if (!fresh || fresh.lockedAt) return fail(err.forbidden(words(context).locked));
    const [existing] = await sql<
      OperationRow[]
    >`SELECT *, restore_revision::text FROM notebooks.annotation_operations WHERE id = ${parsed.data.operationId}::uuid`;
    let operation = existing;
    if (operation) {
      if (
        operation.annotation_id !== id ||
        operation.kind !== kind ||
        operation.actor_kind !== identity.kind ||
        operation.actor_id !== identity.id ||
        (input.expectedText !== undefined && input.expectedText !== operation.expected_text)
      )
        return conflict(words(context).operation);
      if (operation.status === "applied") {
        await changed(access.data.note);
        return ok({ id, operationId: operation.id, status: "applied" as const, state: root.state });
      }
      if (operation.status === "conflict") return conflict(words(context).changed, conflictData(operation.id, operation.current_text));
    } else {
      const [pending] =
        await sql`SELECT id FROM notebooks.annotation_operations WHERE annotation_id = ${id}::uuid AND status = 'pending' LIMIT 1`;
      if (pending) return conflict(words(context).pending, { operationId: pending.id, status: "pending" });
      let before: string;
      let after: string;
      let start: Uint8Array;
      let end: Uint8Array;
      let revision: string;
      if (kind === "accept") {
        if (root.state !== "open" || root.suggestion === null || root.suggestion === root.quote) return conflict(words(context).open);
        const head = await loadHead(access.data.note.id, context);
        try {
          const range = resolveAnnotation({
            doc: head.doc,
            start: root.start_rel,
            end: root.end_rel,
            selector: root,
            sameRevision: root.restore_revision === head.restoreRevision,
          });
          const positions = annotationPositions(head.doc, range.from, range.to);
          start = positions.start;
          end = positions.end;
          revision = head.restoreRevision;
        } finally {
          head.doc.destroy();
        }
        before = parsed.data.expectedText ?? root.quote;
        after = root.suggestion;
      } else {
        if (root.state !== "accepted") return conflict(words(context).accepted);
        const [accepted] = await sql<
          OperationRow[]
        >`SELECT *, restore_revision::text FROM notebooks.annotation_operations WHERE annotation_id = ${id}::uuid AND kind = 'accept' AND status = 'applied' ORDER BY created_at DESC, id DESC LIMIT 1`;
        if (!accepted?.start_rel || !accepted.end_rel) return conflict(words(context).accepted);
        before = accepted.after_text;
        after = accepted.before_text;
        start = accepted.start_rel;
        end = accepted.end_rel;
        revision = accepted.restore_revision;
      }
      [operation] = await sql<
        OperationRow[]
      >`INSERT INTO notebooks.annotation_operations (id, annotation_id, kind, expected_text, before_text, after_text, source_start_rel, source_end_rel, restore_revision, actor_kind, actor_id, actor_name, request_id)
        VALUES (${parsed.data.operationId}::uuid, ${id}::uuid, ${kind}, ${parsed.data.expectedText ?? before}, ${before}, ${after}, ${Buffer.from(start)}, ${Buffer.from(end)}, ${revision}::bigint, ${identity.kind}, ${identity.id}::uuid, ${identity.name}, ${context.requestId}) ON CONFLICT (id) DO NOTHING RETURNING *, restore_revision::text`;
    }
    if (!operation) return conflict(words(context).operation);
    const op = operation;
    try {
      const result = await notes.noteDocuments.edit(
        access.data.note.id,
        {
          actor: { kind: identity.kind, id: identity.id },
          context: { createdBy: identity.kind === "user" ? identity.id : null },
          signal: context.signal,
        },
        async (current) => {
          const doc = new Y.Doc();
          try {
            Y.applyUpdate(doc, current.state());
            const markers = doc.getMap<boolean>("notebooks.annotation.operations");
            // The marker and exact text edit share one Yjs transaction. This is
            // durable evidence even after publish succeeded but store.save failed.
            if (op.prepared_update && op.start_rel && op.end_rel && markers.get(op.id)) return current.text;
            const revision = await notes.getYjsStateWithCursor({ noteId: access.data.note.id });
            const from = absoluteAnnotationPosition(doc, op.source_start_rel);
            const to = absoluteAnnotationPosition(doc, op.source_end_rel);
            const currentText = from !== null && to !== null ? current.text.slice(from, to) : "";
            if (
              !revision ||
              revision.restoreRevision !== op.restore_revision ||
              from === null ||
              to === null ||
              from > to ||
              currentText !== op.expected_text ||
              (kind === "undo" && currentText !== op.before_text)
            )
              throw new OperationConflict(currentText);
            if (op.prepared_update) return { update: new Uint8Array(op.prepared_update) };
            const vector = Y.encodeStateVector(doc);
            const text = doc.getText(SHARED_TEXT_NAME);
            doc.transact(() => {
              if (to > from) text.delete(from, to - from);
              if (op.after_text) text.insert(from, op.after_text);
              markers.set(op.id, true);
            }, "suggestion-accept");
            const positions = annotationPositions(doc, from, from + op.after_text.length);
            // A deletion has one insertion point; use the same assoc on both
            // ends so intervening typing cannot turn a point into a reverse range.
            if (!op.after_text) positions.end = positions.start;
            op.start_rel = positions.start;
            op.end_rel = positions.end;
            op.prepared_update = Y.encodeStateAsUpdate(doc, vector);
            await sql`UPDATE notebooks.annotation_operations SET prepared_update = ${Buffer.from(op.prepared_update)}, start_rel = ${Buffer.from(positions.start)}, end_rel = ${Buffer.from(positions.end)}, updated_at = now() WHERE id = ${op.id}::uuid`;
            return { update: op.prepared_update };
          } finally {
            doc.destroy();
          }
        },
      );
      if (result.status !== "edited" && result.status !== "unchanged")
        return fail({
          code: "ANNOTATION_OPERATION_PENDING",
          message: words(context).retry,
          status: 500,
          details: { operationId: op.id, status: "pending" },
        });
      if (result.status === "edited" && !result.saved.ok)
        return fail({
          code: "ANNOTATION_OPERATION_PENDING",
          message: words(context).retry,
          status: 500,
          details: { operationId: op.id, status: "pending" },
        });
      if (result.status === "unchanged") {
        // A retry after publication still has to materialize content_md/version
        // before it can acknowledge completion to SSR and non-Yjs readers.
        const head = await loadHead(access.data.note.id, context);
        try {
          if (!head.doc.getMap<boolean>("notebooks.annotation.operations").get(op.id) || !head.cursor)
            throw new Error("Suggestion transaction is missing");
          const saved = await notes.save({
            noteId: access.data.note.id,
            yjsState: Y.encodeStateAsUpdate(head.doc),
            contentMd: head.text,
            streamCursor: head.cursor,
            restoreRevision: head.restoreRevision,
            createdBy: identity.kind === "user" ? identity.id : null,
            createVersion: true,
            contributors: [{ kind: identity.kind, id: identity.id, lastContributedAt: new Date(Date.now()) }],
          });
          if (!saved.ok) throw new Error(saved.error);
        } finally {
          head.doc.destroy();
        }
      }
      await sql.begin(async (tx) => {
        await tx`UPDATE notebooks.annotation_operations SET status = 'applied', updated_at = now() WHERE id = ${op.id}::uuid`;
        if (kind === "undo" && op.start_rel && op.end_rel)
          await tx`UPDATE notebooks.annotations SET start_rel = ${Buffer.from(op.start_rel)}, end_rel = ${Buffer.from(op.end_rel)}, restore_revision = ${op.restore_revision}::bigint WHERE id = ${id}::uuid`;
        await tx`UPDATE notebooks.annotations SET state = ${kind === "accept" ? "accepted" : "open"}, state_by_kind = ${identity.kind}, state_by_id = ${identity.id}::uuid, state_by_name = ${identity.name}, state_at = now(), updated_at = now() WHERE id = ${id}::uuid`;
      });
      await changed(access.data.note);
      return ok({ id, operationId: op.id, status: "applied" as const, state: kind === "accept" ? "accepted" : "open" });
    } catch (error) {
      if (error instanceof OperationConflict) {
        await sql`UPDATE notebooks.annotation_operations SET status = 'conflict', current_text = ${error.currentText}, updated_at = now() WHERE id = ${op.id}::uuid`;
        return conflict(words(context).changed, conflictData(op.id, error.currentText));
      }
      // Prepared data remains pending for explicit retry; never silently apply
      // a second text edit with a new ID after an uncertain outcome.
      return fail({
        code: "ANNOTATION_OPERATION_PENDING",
        message: words(context).retry,
        status: 500,
        details: { operationId: op.id, status: "pending" },
      });
    }
  });
};
