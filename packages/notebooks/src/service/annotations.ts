import { env } from "@k2b/cloud/config";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { hasPermission, REQUEST_IDLE_TIMEOUT_SECONDS } from "@k2b/cloud/server";
import { SHARED_TEXT_NAME } from "@k2b/cloud/shared-text";
import { err, fail, i18n, ok, type Result } from "@k2b/stdlib";
import { SQL, sql, type TransactionSQL } from "bun";
import * as Y from "yjs";
import { z } from "zod";
import {
  absoluteAnnotationPosition,
  annotationContext,
  annotationHeadingPath,
  annotationPositions,
  locateAnnotationPassage,
  resolveAnnotation,
} from "../lib/annotation-anchors";
import {
  ANNOTATION_PAGE_SIZE,
  ANNOTATION_QUOTE_MAX_LENGTH,
  ANNOTATION_RESULT_MAX_BYTES,
  type Annotation,
  AnnotationAcceptSchema,
  AnnotationCreateSchema,
  AnnotationEditSchema,
  AnnotationIdSchema,
  AnnotationListSchema,
  AnnotationPageSchema,
  type AnnotationProjection,
  AnnotationRejectSchema,
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
      passageMissing: "The quote does not occur in the note",
      passageAmbiguous: ({ matches }: { matches: number }) =>
        `The quote occurs ${matches} times; pass --occurrence, --prefix/--suffix or --offset-hint`,
      suggestion: "Only an open or rejected suggestion can change rejection status",
      key: "This idempotency key was used with different content",
      own: "Only the author may change this comment within ten minutes",
      replies: "A comment with replies cannot be deleted",
      locked: "Unlock the note before accepting or undoing a suggestion",
      open: "Only an open comment with a suggestion can be accepted",
      accepted: "This comment has no accepted suggestion to undo",
      undoFirst: "Undo the accepted suggestion before changing it or the thread status",
      changed: "The text has changed since this suggestion was made",
      operation: "This operation ID belongs to another request",
      pending: "Another suggestion operation is pending. Retry its operation ID.",
      retry: "The suggestion could not be saved. Retry with the same operation ID.",
      cursor: "Invalid comment cursor",
      busy: "Timed out waiting for another comment update. Retry this request.",
    },
    de: {
      unavailable: "Notiz oder Kommentar nicht gefunden",
      write: "Schreibzugriff ist erforderlich",
      invalid: "Bitte die Kommentareingabe prüfen",
      passageMissing: "Das Zitat kommt in der Notiz nicht vor",
      passageAmbiguous: ({ matches }) =>
        `Das Zitat kommt ${matches}-mal vor; bitte --occurrence, --prefix/--suffix oder --offset-hint angeben`,
      suggestion: "Nur ein offener oder abgelehnter Vorschlag kann abgelehnt oder wieder geöffnet werden",
      key: "Dieser Idempotenzschlüssel wurde mit anderem Inhalt verwendet",
      own: "Nur der Autor kann diesen Kommentar innerhalb von zehn Minuten ändern",
      replies: "Ein Kommentar mit Antworten kann nicht gelöscht werden",
      locked: "Bitte die Notiz entsperren, bevor ein Vorschlag übernommen oder rückgängig gemacht wird",
      open: "Nur ein offener Kommentar mit Vorschlag kann übernommen werden",
      accepted: "Dieser Kommentar hat keinen übernommenen Vorschlag zum Rückgängigmachen",
      undoFirst: "Bitte den übernommenen Vorschlag rückgängig machen, bevor er oder der Kommentarstatus geändert wird",
      changed: "Der Text wurde inzwischen geändert",
      operation: "Diese Vorgangs-ID gehört zu einer anderen Anfrage",
      pending: "Ein anderer Vorschlagsvorgang ist offen. Bitte dessen Vorgangs-ID erneut verwenden.",
      retry: "Der Vorschlag konnte nicht gespeichert werden. Bitte mit derselben Vorgangs-ID erneut versuchen.",
      cursor: "Ungültiger Kommentar-Cursor",
      busy: "Eine andere Kommentaränderung dauert zu lange. Bitte erneut versuchen.",
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

type SuggestionRow = {
  suggestion: string | null;
  suggestion_state: "open" | "accepted" | "rejected" | null;
  suggestion_state_by_kind: "user" | "service_account" | null;
  suggestion_state_by_id: string | null;
  suggestion_state_by_name: string | null;
  suggestion_state_at: Date | null;
  suggestion_state_via: "assistant" | "mcp" | null;
};
type RootRow = SuggestionRow & {
  id: string;
  note_id: string;
  start_rel: Uint8Array;
  end_rel: Uint8Array;
  restore_revision: string;
  quote: string;
  prefix: string;
  suffix: string;
  body: string;
  state: "open" | "resolved" | "accepted";
  state_by_kind: "user" | "service_account" | null;
  state_by_id: string | null;
  state_by_name: string | null;
  state_at: Date | null;
  state_via: "assistant" | "mcp" | null;
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
type ReplyRow = SuggestionRow &
  Pick<
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
  reply_id: string | null;
  via: "assistant" | "mcp" | null;
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
const suggestionProjection = (row: SuggestionRow) => ({
  suggestion: row.suggestion,
  suggestionState: row.suggestion_state,
  suggestionStateBy:
    row.suggestion_state_by_kind && row.suggestion_state_by_id
      ? { kind: row.suggestion_state_by_kind, id: row.suggestion_state_by_id, name: row.suggestion_state_by_name ?? "" }
      : null,
  suggestionStateAt: row.suggestion_state_at?.toISOString() ?? null,
  suggestionStateVia: row.suggestion_state_via,
});
const mapReply = (row: ReplyRow, context: AnnotationContext, canWrite: boolean) => ({
  id: row.id,
  body: row.body,
  ...suggestionProjection(row),
  author: person(row),
  via: row.via,
  createdAt: row.created_at.toISOString(),
  editedAt: row.edited_at?.toISOString() ?? null,
  canEdit: !row.deleted_at && mutable(row, context, canWrite),
  canDelete: !row.deleted_at && row.suggestion_state !== "accepted" && mutable(row, context, canWrite),
});
// Match Bun SQL's default pool size (10), separately from the text store's
// pool: independent notes can progress while a write replays a large document,
// and advisory-lock waiters cannot consume the store's save connections.
let transactionPool: SQL | undefined;
const annotationTransactions = () => (transactionPool ??= new SQL({ url: env.DATABASE_URL, max: 10 }));
// Spend at most half the normal request idle budget waiting, leaving time to
// replay/save the document and send a retryable conflict before the socket closes.
const ANNOTATION_LOCK_TIMEOUT_MS = (REQUEST_IDLE_TIMEOUT_SECONDS * 1000) / 2;
export const close = async () => {
  const pool = transactionPool;
  transactionPool = undefined;
  await pool?.close();
};
const withNoteLock = async <T>(
  noteId: string,
  context: AnnotationContext,
  run: (tx: TransactionSQL) => Promise<Result<T>>,
): Promise<Result<T>> => {
  try {
    return await annotationTransactions().begin(async (tx) => {
      context.signal.throwIfAborted();
      // Only the fixed platform budget is interpolated into SET LOCAL.
      await tx.unsafe(`SET LOCAL lock_timeout = '${ANNOTATION_LOCK_TIMEOUT_MS}ms'`);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`notebooks.annotations:${noteId}`}, 0))`;
      context.signal.throwIfAborted();
      return run(tx);
    });
  } catch (error) {
    if (error instanceof SQL.PostgresError && error.errno === "55P03") return conflict(words(context).busy, { retryable: true });
    throw error;
  }
};
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
    ...suggestionProjection(row),
    state: row.state,
    stateBy: row.state_by_kind && row.state_by_id ? { kind: row.state_by_kind, id: row.state_by_id, name: row.state_by_name ?? "" } : null,
    stateAt: row.state_at?.toISOString() ?? null,
    stateVia: row.state_via,
    author: person(row),
    via: row.via,
    createdAt: row.created_at.toISOString(),
    editedAt: row.edited_at?.toISOString() ?? null,
    canEdit: !row.deleted_at && mutable(row, context, canWrite),
    canDelete: !row.deleted_at && row.state !== "accepted" && mutable(row, context, canWrite) && replies.length === 0,
    replies: visible.map((reply) => mapReply(reply, context, canWrite)),
    repliesNextCursor: replies.length > visible.length ? encodeCursor(visible[visible.length - 1]!) : null,
    headingPath: annotationHeadingPath(head.text, range.from),
    acceptedOperationId: row.state === "accepted" ? (accepted?.id ?? null) : null,
  };
};
type Cursor = { at: string; id: string };
const CursorTimeSchema = z.iso.datetime({ offset: true });
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
      CursorTimeSchema.safeParse(cursor.at.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")).success &&
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
const DATA_BUDGET = ANNOTATION_RESULT_MAX_BYTES;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

export const list = async (
  noteId: string,
  input: z.input<typeof AnnotationListSchema>,
  context: AnnotationContext,
  options: { compact?: boolean } = {},
): Promise<Result<AnnotationProjection>> => {
  const parsed = AnnotationListSchema.safeParse(input);
  if (!parsed.success) return fail(err.badInput(words(context).invalid));
  const access = await authorize(noteId, context);
  if (!access.ok) return access;
  let cursor: Cursor | null;
  try {
    cursor = decodeCursor(parsed.data.cursor);
  } catch {
    return fail(err.badInput(words(context).cursor));
  }
  const author = parsed.data.author === "me" ? actor(context).id : parsed.data.author;
  const head = await loadHead(access.data.note.id, context);
  try {
    const rows = await sql<RootRow[]>`SELECT *, created_at::text AS cursor_at, restore_revision::text FROM notebooks.annotations
      WHERE note_id = ${access.data.note.id}::uuid AND deleted_at IS NULL
        AND (${parsed.data.state} = 'all' OR state = ${parsed.data.state})
        AND (${author ?? null}::uuid IS NULL OR author_id = ${author ?? null}::uuid)
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
};
export const read = async (noteId: string, id: string, context: AnnotationContext) => {
  if (!AnnotationIdSchema.safeParse(id).success) return notFound(context);
  const access = await authorize(noteId, context);
  if (!access.ok) return access;
  const row = await loadRoot(access.data.note.id, id);
  if (!row || row.deleted_at) return notFound(context);
  const head = await loadHead(access.data.note.id, context);
  try {
    return ok(await projectRoot(row, head, noteId, context, access.data.canWrite));
  } finally {
    head.doc.destroy();
  }
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
      const passage = locateAnnotationPassage(head.text, value, value.offsetHint, value.occurrence);
      if (passage.from === null)
        return fail({
          code: passage.ambiguous ? "ANNOTATION_PASSAGE_AMBIGUOUS" : "ANNOTATION_PASSAGE_NOT_FOUND",
          message: passage.ambiguous ? words(context).passageAmbiguous({ matches: passage.matches }) : words(context).passageMissing,
          status: 409,
          details: { matches: passage.matches },
        });
      const from = passage.from;
      const to = from + value.quote.length;
      const positions = annotationPositions(head.doc, from, to);
      const contextText = annotationContext(head.text, from, to);
      const [row] = await tx<RootRow[]>`INSERT INTO notebooks.annotations (
        note_id, start_rel, end_rel, restore_revision, quote, prefix, suffix, body, suggestion, suggestion_state,
        author_kind, author_id, author_name, author_avatar_hash, via, idempotency_key, payload_hash, request_id
      ) VALUES (${access.data.note.id}::uuid, ${Buffer.from(positions.start)}, ${Buffer.from(positions.end)}, ${head.restoreRevision}::bigint,
        ${value.quote}, ${contextText.prefix}, ${contextText.suffix},
        ${value.body}, ${value.suggestion ?? null}, ${value.suggestion == null ? null : "open"}, ${identity.kind}, ${identity.id}::uuid, ${identity.name}, ${identity.avatarHash}, ${via(context)}, ${value.idempotencyKey}, ${hash}, ${context.requestId}) RETURNING *, created_at::text AS cursor_at, restore_revision::text`;
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
const replyHasContent = async (root: RootRow, body: string, suggestion: string | null, context: AnnotationContext) => {
  if (body) return true;
  if (suggestion === null) return false;
  const head = await loadHead(root.note_id, context);
  try {
    const range = resolveAnnotation({
      doc: head.doc,
      start: root.start_rel,
      end: root.end_rel,
      selector: root,
      sameRevision: root.restore_revision === head.restoreRevision,
    });
    return suggestion !== (range.orphan ? root.quote : head.text.slice(range.from, range.to));
  } finally {
    head.doc.destroy();
  }
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
    const suggestion = parsed.data.suggestion ?? null;
    // Preserve retry hashes for existing replies without a suggestion.
    const hash =
      suggestion === null
        ? noteContentHash(parsed.data.body)
        : `suggestion:${noteContentHash(JSON.stringify({ body: parsed.data.body, suggestion }))}`;
    const [existing] = await sql<
      ReplyRow[]
    >`SELECT *, created_at::text AS cursor_at FROM notebooks.annotation_replies WHERE annotation_id = ${id}::uuid AND author_kind = ${identity.kind} AND author_id = ${identity.id}::uuid AND idempotency_key = ${parsed.data.idempotencyKey}`;
    if (existing) {
      if (existing.payload_hash !== hash) return conflict(words(context).key);
      await changed(access.data.note);
      return ok(mapReply(existing, context, true));
    }
    if (!(await replyHasContent(root, parsed.data.body, suggestion, context))) return fail(err.badInput(words(context).invalid));
    const [row] = await sql<
      ReplyRow[]
    >`INSERT INTO notebooks.annotation_replies (annotation_id, author_kind, author_id, author_name, author_avatar_hash, via, body, suggestion, suggestion_state, idempotency_key, payload_hash, request_id)
      VALUES (${id}::uuid, ${identity.kind}, ${identity.id}::uuid, ${identity.name}, ${identity.avatarHash}, ${via(context)}, ${parsed.data.body}, ${suggestion}, ${suggestion === null ? null : "open"}, ${parsed.data.idempotencyKey}, ${hash}, ${context.requestId}) RETURNING *, created_at::text AS cursor_at`;
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
      if (input.replyId || root.state === "accepted") return conflict(words(context).undoFirst);
      const [pending] =
        await sql`SELECT id FROM notebooks.annotation_operations WHERE annotation_id = ${id}::uuid AND status = 'pending' LIMIT 1`;
      if (pending) return conflict(words(context).pending, { operationId: pending.id, status: "pending" });
      const identity = actor(context);
      await sql`UPDATE notebooks.annotations SET state = ${input.kind === "resolve" ? "resolved" : "open"}, state_by_kind = ${identity.kind}, state_by_id = ${identity.id}::uuid, state_by_name = ${identity.name}, state_at = now(), state_via = ${via(context)}, updated_at = now() WHERE id = ${id}::uuid`;
    } else {
      if (!mutable(row, context, true)) return fail(err.forbidden(words(context).own));
      if (input.kind === "edit") {
        const parsed = AnnotationEditSchema.safeParse({
          body: input.body,
          ...(input.suggestion !== undefined ? { suggestion: input.suggestion } : {}),
        });
        if (!parsed.success) return fail(err.badInput(words(context).invalid));
        const suggestion = input.suggestion === undefined ? row.suggestion : input.suggestion;
        const hasContent = replyRow
          ? await replyHasContent(root, parsed.data.body, suggestion, context)
          : parsed.data.body.length > 0 || (suggestion !== null && suggestion !== root.quote);
        if (!hasContent) return fail(err.badInput(words(context).invalid));
        const [pending] =
          await sql`SELECT id FROM notebooks.annotation_operations WHERE annotation_id = ${id}::uuid AND status = 'pending' LIMIT 1`;
        if (pending && suggestion !== row.suggestion)
          return conflict(words(context).pending, { operationId: pending.id, status: "pending" });
        if (row.suggestion_state === "accepted" && suggestion !== row.suggestion) return conflict(words(context).undoFirst);
        const identity = actor(context);
        const newSuggestion = suggestion !== row.suggestion && suggestion !== null;
        const state = suggestion === row.suggestion ? row.suggestion_state : suggestion === null ? null : "open";
        const table = replyRow ? "notebooks.annotation_replies" : "notebooks.annotations";
        await sql`UPDATE ${sql(table)} SET body = ${parsed.data.body}, suggestion = ${suggestion}, suggestion_state = ${state},
          suggestion_state_by_kind = ${suggestion === row.suggestion ? row.suggestion_state_by_kind : newSuggestion ? identity.kind : null},
          suggestion_state_by_id = ${suggestion === row.suggestion ? row.suggestion_state_by_id : newSuggestion ? identity.id : null}::uuid,
          suggestion_state_by_name = ${suggestion === row.suggestion ? row.suggestion_state_by_name : newSuggestion ? identity.name : null},
          suggestion_state_at = ${suggestion === row.suggestion ? row.suggestion_state_at : newSuggestion ? new Date(Date.now()) : null},
          suggestion_state_via = ${suggestion === row.suggestion ? row.suggestion_state_via : newSuggestion ? via(context) : null},
          edited_at = now(), updated_at = now() WHERE id = ${row.id}::uuid`;
      } else {
        if (input.kind === "delete" && (row.suggestion_state === "accepted" || (!replyRow && root.state === "accepted")))
          return conflict(words(context).undoFirst);
        if (input.kind === "delete" && replyRow) {
          const [pending] =
            await sql`SELECT id FROM notebooks.annotation_operations WHERE annotation_id = ${id}::uuid AND reply_id = ${row.id}::uuid AND status = 'pending' LIMIT 1`;
          if (pending) return conflict(words(context).pending, { operationId: pending.id, status: "pending" });
        }
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

const loadSuggestion = async (root: RootRow, replyId: string | undefined) => {
  if (!replyId) return root;
  const [row] = await sql<ReplyRow[]>`SELECT *, created_at::text AS cursor_at FROM notebooks.annotation_replies
    WHERE id = ${replyId}::uuid AND annotation_id = ${root.id}::uuid AND deleted_at IS NULL`;
  return row ?? null;
};
export const reject = async (noteId: string, id: string, input: z.input<typeof AnnotationRejectSchema>, context: AnnotationContext) => {
  const parsed = AnnotationRejectSchema.safeParse(input);
  if (!parsed.success) return fail(err.badInput(words(context).invalid));
  if (!AnnotationIdSchema.safeParse(id).success) return notFound(context);
  const access = await authorize(noteId, context, true);
  if (!access.ok) return access;
  return withNoteLock(access.data.note.id, context, async () => {
    const root = await loadRoot(access.data.note.id, id);
    if (!root || root.deleted_at) return notFound(context);
    const selected = await loadSuggestion(root, parsed.data.replyId);
    if (!selected) return notFound(context);
    if (selected.suggestion === null || selected.suggestion_state === "accepted") return conflict(words(context).suggestion);
    const [pending] =
      await sql`SELECT id FROM notebooks.annotation_operations WHERE annotation_id = ${id}::uuid AND status = 'pending' LIMIT 1`;
    if (pending) return conflict(words(context).pending, { operationId: pending.id, status: "pending" });
    const state = parsed.data.rejected ? "rejected" : "open";
    if (selected.suggestion_state !== state) {
      const identity = actor(context);
      const table = parsed.data.replyId ? "notebooks.annotation_replies" : "notebooks.annotations";
      await sql`UPDATE ${sql(table)} SET suggestion_state = ${state}, suggestion_state_by_kind = ${identity.kind},
        suggestion_state_by_id = ${identity.id}::uuid, suggestion_state_by_name = ${identity.name},
        suggestion_state_at = now(), suggestion_state_via = ${via(context)}, updated_at = now() WHERE id = ${selected.id}::uuid`;
    }
    await changed(access.data.note);
    return ok({ id: selected.id, annotationId: id, deleted: false });
  });
};

/** Approval snapshots show the exact proposed replacement, including a custom accepted source. */
export const previewOperation = async (
  noteId: string,
  id: string,
  kind: "accept" | "undo",
  expectedText: string | undefined,
  context: AnnotationContext,
  replyId?: string,
) => {
  if (!AnnotationIdSchema.safeParse(id).success || (replyId && !AnnotationIdSchema.safeParse(replyId).success)) return notFound(context);
  const access = await authorize(noteId, context, true);
  if (!access.ok) return access;
  const root = await loadRoot(access.data.note.id, id);
  if (!root || root.deleted_at) return notFound(context);
  if (kind === "accept") {
    const selected = await loadSuggestion(root, replyId);
    if (!selected) return notFound(context);
    if (root.state !== "open" || selected.suggestion === null || selected.suggestion_state !== "open") return conflict(words(context).open);
    return ok({ before: expectedText ?? root.quote, after: selected.suggestion });
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
  input: z.input<typeof AnnotationAcceptSchema>,
  context: AnnotationContext,
) => {
  const parsed = AnnotationAcceptSchema.safeParse(input);
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
        (kind === "accept" && operation.reply_id !== (parsed.data.replyId ?? null)) ||
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
      let replyId = parsed.data.replyId ?? null;
      if (kind === "accept") {
        const selected = await loadSuggestion(root, parsed.data.replyId);
        if (!selected) return notFound(context);
        if (root.state !== "open" || selected.suggestion === null || selected.suggestion_state !== "open")
          return conflict(words(context).open);
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
        after = selected.suggestion;
      } else {
        if (root.state !== "accepted") return conflict(words(context).accepted);
        const [accepted] = await sql<
          OperationRow[]
        >`SELECT *, restore_revision::text FROM notebooks.annotation_operations WHERE annotation_id = ${id}::uuid AND kind = 'accept' AND status = 'applied' ORDER BY created_at DESC, id DESC LIMIT 1`;
        if (!accepted?.start_rel || !accepted.end_rel) return conflict(words(context).accepted);
        replyId = accepted.reply_id;
        before = accepted.after_text;
        after = accepted.before_text;
        start = accepted.start_rel;
        end = accepted.end_rel;
        revision = accepted.restore_revision;
      }
      [operation] = await sql<
        OperationRow[]
      >`INSERT INTO notebooks.annotation_operations (id, annotation_id, reply_id, via, kind, expected_text, before_text, after_text, source_start_rel, source_end_rel, restore_revision, actor_kind, actor_id, actor_name, request_id)
        VALUES (${parsed.data.operationId}::uuid, ${id}::uuid, ${replyId}::uuid, ${via(context)}, ${kind}, ${parsed.data.expectedText ?? before}, ${before}, ${after}, ${Buffer.from(start)}, ${Buffer.from(end)}, ${revision}::bigint, ${identity.kind}, ${identity.id}::uuid, ${identity.name}, ${context.requestId}) ON CONFLICT (id) DO NOTHING RETURNING *, restore_revision::text`;
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
        // Accept follows the inserted items; undo follows the restored items.
        if (op.start_rel && op.end_rel)
          await tx`UPDATE notebooks.annotations SET start_rel = ${Buffer.from(op.start_rel)}, end_rel = ${Buffer.from(op.end_rel)}, restore_revision = ${op.restore_revision}::bigint WHERE id = ${id}::uuid`;
        await tx`UPDATE notebooks.annotations SET state = ${kind === "accept" ? "accepted" : "open"}, state_by_kind = ${identity.kind}, state_by_id = ${identity.id}::uuid, state_by_name = ${identity.name}, state_at = now(), state_via = ${op.via}, updated_at = now() WHERE id = ${id}::uuid`;
        const table = op.reply_id ? "notebooks.annotation_replies" : "notebooks.annotations";
        await tx`UPDATE ${tx(table)} SET suggestion_state = ${kind === "accept" ? "accepted" : "open"},
          suggestion_state_by_kind = ${identity.kind}, suggestion_state_by_id = ${identity.id}::uuid,
          suggestion_state_by_name = ${identity.name}, suggestion_state_at = now(), suggestion_state_via = ${op.via},
          updated_at = now() WHERE id = ${op.reply_id ?? id}::uuid`;
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
