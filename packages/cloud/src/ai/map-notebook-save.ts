import { z } from "zod";
import { type CapabilityClientError, type CapabilityHttpOptions, invokeCapabilityWithDataSchema } from "../capabilities/client";
import { CAPABILITY_MAX_REQUEST_BYTES } from "../contracts/capabilities";
import { cloudResourceHref } from "../contracts/resource-href";

const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const shortId = z.string().regex(/^[A-Za-z0-9]{6}$/);
const offset = z.number().int().nonnegative();
const pendingSchema = z
  .object({
    kind: z.enum(["create", "append"]),
    key: z.string().min(1).max(200),
    end: offset,
    beforeHash: hashSchema,
    afterHash: hashSchema,
  })
  .strict();

/** Persist under the signed-in user and source key; retain saved checkpoints to prevent duplicates. */
export const MapNotebookSaveCheckpointSchema = z
  .object({
    version: z.literal(1),
    sourceKey: z.string().min(1).max(256),
    notebookId: shortId,
    contentHash: hashSchema,
    total: offset,
    completed: offset,
    attempt: offset,
    noteId: shortId.optional(),
    pending: pendingSchema.optional(),
  })
  .strict();
export type MapNotebookSaveCheckpoint = z.infer<typeof MapNotebookSaveCheckpointSchema>;
export type MapNotebookSaveResult = {
  status: "saved" | "cancelled" | "conflict" | "unknown" | "error";
  checkpoint?: MapNotebookSaveCheckpoint;
  notebookHref: string;
  noteId?: string;
  noteHref?: string;
  /** Stable helper code or the original capability error code; caller supplies localized UI text. */
  code?: string;
  message?: string;
};
export type MapNotebookSaveOptions = {
  /** Exact server export, with its existing first # title. Refetch the same export on resume. */
  content: string;
  notebookId: string;
  /** Map ID + revision (and conversation if needed), stable across explicit resumes. */
  sourceKey: string;
  checkpoint?: MapNotebookSaveCheckpoint;
  /** Must durably persist before resolving. Called before EVERY mutation and after every receipt. */
  onCheckpoint: (checkpoint: MapNotebookSaveCheckpoint) => void | Promise<void>;
  signal?: AbortSignal;
  /** Normal public capability transport; also supplies a fake HTTP seam for tests. */
  client?: CapabilityHttpOptions;
};

const encoder = new TextEncoder();
const hash = async (content: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(content));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};
const fits = (input: unknown): boolean => encoder.encode(JSON.stringify({ input })).byteLength <= CAPABILITY_MAX_REQUEST_BYTES;
// Offsets and public character caps use UTF-16. Keep a supplementary character in one request.
const boundary = (content: string, end: number): number =>
  end > 0 && end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]!) && /[\uDC00-\uDFFF]/.test(content[end]!) ? end - 1 : end;

const createEnd = (content: string, notebookId: string): number => {
  let low = 0;
  let high = Math.min(content.length, 200_000);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits({ notebookId, content: content.slice(0, mid) })) low = mid;
    else high = mid - 1;
  }
  return boundary(content, low);
};
type Append = { kind: "append"; content: string; separator: "none" };
const appendBatch = (content: string, start: number, noteId: string, ifContentHash: string) => {
  const operations: Append[] = [];
  let end = start;
  while (end < content.length && operations.length < 20) {
    const next = boundary(content, Math.min(end + 10_000, content.length));
    const operation: Append = { kind: "append", content: content.slice(end, next), separator: "none" };
    if (!fits({ noteId, ifContentHash, blockLimit: 0, operations: [...operations, operation] })) break;
    operations.push(operation);
    end = next;
  }
  return { end, input: { noteId, ifContentHash, blockLimit: 0, operations } };
};
// The platform treats a valid owning-app 4xx as no effect. Unknown/claim errors are exceptions.
const definitelyRejected = (error: CapabilityClientError): boolean =>
  error.status >= 400 &&
  error.status < 500 &&
  ![
    "IDEMPOTENCY_IN_PROGRESS",
    "IDEMPOTENCY_UNCERTAIN",
    "IDEMPOTENCY_CONFLICT",
    "ACTION_OUTCOME_UNKNOWN",
    "REQUEST_CANCELLED",
    "DEADLINE_EXCEEDED",
    "INVALID_APP_RESPONSE",
    "RESPONSE_TOO_LARGE",
  ].includes(error.code);

const noteSchema = z.object({ id: shortId, notebookId: shortId });
const readSchema = noteSchema.extend({ contentHash: hashSchema });
const editSchema = z.object({ beforeHash: hashSchema, afterHash: hashSchema });

/**
 * One bounded save, with no automatic retries. The app invokes this again for explicit resume.
 * Unknown creates are never repeated, even after the platform's 24-hour claim retention.
 * note.edit forbids idempotency headers; full-content hashes detect changed prefixes. An uncertain append at the old hash stays unknown.
 * This helper uses ordinary capabilities and never approves an Action on the caller's behalf.
 */
export async function saveMapNotebook(options: MapNotebookSaveOptions): Promise<MapNotebookSaveResult> {
  const { content, notebookId, sourceKey, signal, client } = options;
  const notebookHref = cloudResourceHref({ type: "notebooks.notebook", id: notebookId });
  let checkpoint: MapNotebookSaveCheckpoint | undefined;
  const result = (status: MapNotebookSaveResult["status"], code?: string, message?: string): MapNotebookSaveResult => ({
    status,
    checkpoint,
    notebookHref,
    code,
    message,
    ...(checkpoint?.noteId
      ? { noteId: checkpoint.noteId, noteHref: cloudResourceHref({ type: "notebooks.note", id: checkpoint.noteId }) }
      : {}),
  });
  const persist = async (next: MapNotebookSaveCheckpoint) => {
    checkpoint = next;
    // Never hand mutable internal state to the storage/UI callback.
    await options.onCheckpoint(structuredClone(next));
  };
  const read = (id: string) =>
    invokeCapabilityWithDataSchema(
      {
        kind: "query",
        appId: "notebooks",
        capabilityId: "note.read",
        input: { id, contentLimit: 1 },
        signal,
      },
      readSchema,
      client,
    );
  try {
    shortId.parse(notebookId);
    z.string().min(1).max(256).parse(sourceKey);
    // The exporter supplies a title; otherwise note.create may prepend one and change the prefix.
    const titleEnd = content.indexOf("\n");
    if (!/^# [^\r\n\s][^\r\n]*/.test(content)) return result("error", "invalid_title");
    const contentHash = await hash(content);
    if (options.checkpoint) {
      checkpoint = MapNotebookSaveCheckpointSchema.parse(options.checkpoint);
      if (
        checkpoint.sourceKey !== sourceKey ||
        checkpoint.notebookId !== notebookId ||
        checkpoint.contentHash !== contentHash ||
        checkpoint.total !== content.length ||
        checkpoint.completed > content.length ||
        (!checkpoint.noteId && checkpoint.completed !== 0)
      )
        return result("conflict", "source_changed");
      const pending = checkpoint.pending;
      if (
        pending &&
        (pending.end <= checkpoint.completed ||
          pending.end > content.length ||
          pending.beforeHash !== (await hash(content.slice(0, checkpoint.completed))) ||
          pending.afterHash !== (await hash(content.slice(0, pending.end))) ||
          (pending.kind === "create") === Boolean(checkpoint.noteId))
      )
        return result("conflict", "invalid_checkpoint");
    } else {
      checkpoint = { version: 1, sourceKey, notebookId, contentHash, total: content.length, completed: 0, attempt: 0 };
    }
    if (signal?.aborted) return result("cancelled", "cancelled");
    if (checkpoint.pending?.kind === "create") return result("unknown", "create_outcome_unknown");
    if (checkpoint.noteId) {
      const current = await read(checkpoint.noteId);
      if (!current.ok) return result(signal?.aborted ? "cancelled" : "unknown", current.error.code, current.error.message);
      if (current.data.data.id !== checkpoint.noteId || current.data.data.notebookId !== notebookId)
        return result("conflict", "note_moved");
      const currentHash = current.data.data.contentHash;
      if (checkpoint.pending && currentHash === checkpoint.pending.afterHash) {
        await persist({ ...checkpoint, completed: checkpoint.pending.end, pending: undefined });
      } else if (currentHash === (await hash(content.slice(0, checkpoint.completed)))) {
        // The service checks the hash before publication, without compare-and-swap.
        // The original request could still publish later: the old hash is NOT proof of no effect.
        if (checkpoint.pending) return result("unknown", "append_outcome_unknown");
      } else return result("conflict", "content_changed");
    }
    // Every iteration consumes a nonempty prefix: no retries, no work independent of source size.
    while (checkpoint.completed < content.length) {
      if (signal?.aborted) return result("cancelled", "cancelled");
      const beforeHash = await hash(content.slice(0, checkpoint.completed));
      const batch = checkpoint.noteId ? appendBatch(content, checkpoint.completed, checkpoint.noteId, beforeHash) : undefined;
      const end = batch?.end ?? createEnd(content, notebookId);
      if (end <= checkpoint.completed || (!checkpoint.noteId && end < (titleEnd < 0 ? content.length : titleEnd + 1))) {
        return result("error", "request_too_large");
      }
      const afterHash = await hash(content.slice(0, end));
      // Source digest scopes creates across reloads; offset + attempt identifies each batch.
      const key = `map-note:${await hash(`${sourceKey}:${notebookId}:${contentHash}`)}:${checkpoint.completed}:${checkpoint.attempt}`;
      const pending = { kind: checkpoint.noteId ? ("append" as const) : ("create" as const), key, end, beforeHash, afterHash };
      try {
        await persist({ ...checkpoint, pending, attempt: checkpoint.attempt + 1 });
      } catch (cause) {
        // This attempt is known unsent, even if storage wrote and then threw.
        // Keep its incremented identity; a caller can persist this safe checkpoint and resume.
        checkpoint = { ...checkpoint, pending: undefined };
        return result("error", "checkpoint_failed", cause instanceof Error ? cause.message : String(cause));
      }
      if (signal?.aborted) {
        // Nothing was dispatched; the next explicit resume can safely use a new attempt.
        await persist({ ...checkpoint, pending: undefined });
        return result("cancelled", "cancelled");
      }
      if (!batch) {
        const created = await invokeCapabilityWithDataSchema(
          {
            kind: "action",
            appId: "notebooks",
            capabilityId: "note.create",
            input: { notebookId, content: content.slice(0, end) },
            idempotencyKey: key,
            signal,
          },
          noteSchema,
          client,
        );
        if (!created.ok) {
          if (definitelyRejected(created.error)) {
            await persist({ ...checkpoint, pending: undefined });
            return result("error", created.error.code, created.error.message);
          }
          return result(signal?.aborted ? "cancelled" : "unknown", created.error.code, created.error.message);
        }
        // Persist the known ID before querying or performing another mutation.
        await persist({ ...checkpoint, noteId: created.data.data.id, completed: end, pending: undefined });
        if (created.data.data.notebookId !== notebookId) return result("conflict", "note_moved");
        const current = await read(created.data.data.id);
        if (!current.ok) return result(signal?.aborted ? "cancelled" : "unknown", current.error.code, current.error.message);
        if (current.data.data.contentHash !== afterHash || current.data.data.notebookId !== notebookId)
          return result("conflict", "content_changed");
      } else {
        const edited = await invokeCapabilityWithDataSchema(
          {
            kind: "action",
            appId: "notebooks",
            capabilityId: "note.edit",
            input: batch.input,
            signal,
          },
          editSchema,
          client,
        );
        if (!edited.ok) {
          if (definitelyRejected(edited.error)) {
            await persist({ ...checkpoint, pending: undefined });
            return result(edited.error.status === 409 ? "conflict" : "error", edited.error.code, edited.error.message);
          }
          return result(signal?.aborted ? "cancelled" : "unknown", edited.error.code, edited.error.message);
        }
        if (edited.data.data.beforeHash !== beforeHash || edited.data.data.afterHash !== afterHash)
          return result("conflict", "unexpected_receipt");
        await persist({ ...checkpoint, completed: end, pending: undefined });
      }
    }
    return result("saved");
  } catch (cause) {
    // Includes persistence failures. Never proceed to a dependent mutation after a failed callback.
    return result(signal?.aborted ? "cancelled" : "error", "save_failed", cause instanceof Error ? cause.message : String(cause));
  }
}
