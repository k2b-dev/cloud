import { query } from "@k2b/stdlib/solid";
import { type Accessor, createMemo, createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import type { Annotation, AnnotationProjection } from "../../../../lib/annotation-contracts";
import { WORKSPACE_EVENT, type WorkspaceEventDetail } from "../sidebar/workspace-events";

/**
 * The comments of one note for its margin: one projection from the server (comments, their places in one text, and
 * that text), reloaded after every change. Notebooks owns the comments; this store holds no second copy beyond the
 * pending writes it shows at once.
 */

/** Pages the margin reads at most: 20 pages of 30 comments. A note with more shows the first 600. */
const MAX_PAGES = 20;

export class CommentRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> | undefined,
  ) {
    super(message);
  }
}

/** What the typed client returns: enough of a Response for these calls. */
type Reply = { ok: boolean; status: number; json(): Promise<unknown> };

const failure = async (response: Reply, fallback: string) => {
  let message = fallback;
  let details: Record<string, unknown> | undefined;
  try {
    const body = (await response.json()) as { message?: unknown; details?: unknown };
    if (typeof body.message === "string" && body.message) message = body.message;
    if (body.details && typeof body.details === "object") details = body.details as Record<string, unknown>;
  } catch {
    // The status and fallback message remain.
  }
  return new CommentRequestError(message, response.status, details);
};

export type CommentDraft = {
  from: number;
  to: number;
  quote: string;
  prefix: string;
  suffix: string;
  body: string;
  suggestion: string | null;
  /** Kept across retries so a repeated save never creates the comment twice. */
  idempotencyKey: string;
  saving: boolean;
  failed: boolean;
};

export type CommentsStore = ReturnType<typeof createCommentsStore>;

export const createCommentsStore = (options: {
  notebookId: string;
  noteId: string;
  initial?: AnnotationProjection | null;
  enabled: Accessor<boolean>;
  failedMessage: Accessor<string>;
}) => {
  const param = { noteId: options.noteId };
  const route = () => apiClient.notes[":noteId"].annotations;
  const comments = query.create({
    source: () => `${options.notebookId}/${options.noteId}`,
    enabled: options.enabled,
    ...(options.initial ? { initial: { source: `${options.notebookId}/${options.noteId}`, data: options.initial } } : {}),
    load: async (_source, { abortSignal }) => {
      let projection: AnnotationProjection | undefined;
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const response = await route().$get({ param, query: cursor ? { cursor } : {} }, { init: { signal: abortSignal } });
        if (!response.ok) throw await failure(response, options.failedMessage());
        const next = (await response.json()) as AnnotationProjection;
        // Every page answers for the same text; a page from a newer text starts over with it.
        projection =
          projection && projection.contentHash === next.contentHash ? { ...next, items: [...projection.items, ...next.items] } : next;
        if (!next.nextCursor) break;
        cursor = next.nextCursor;
      }
      return projection!;
    },
    subscribe: ({ invalidate }) => {
      const handle = (raw: Event) => {
        const detail = (raw as CustomEvent<WorkspaceEventDetail>).detail;
        const { event } = detail;
        if (event.notebookId !== options.notebookId) return;
        // A change of the note's text moves passages too; the editor maps them until the projection arrives.
        if ((event.type === "note.comments.changed" && event.noteId === options.noteId) || event.type === "workspace.invalidated")
          detail.cover(invalidate());
      };
      window.addEventListener(WORKSPACE_EVENT, handle);
      return () => window.removeEventListener(WORKSPACE_EVENT, handle);
    },
  });

  /** Comment ids hidden at once while their deletion or resolution is on its way. */
  const [hidden, setHidden] = createSignal<ReadonlySet<string>>(new Set());
  const hide = (id: string, on: boolean) =>
    setHidden((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  // The server renders the first page; a note with more comments reads the rest at once.
  if (options.initial?.nextCursor) queueMicrotask(() => void comments.refresh().catch(() => undefined));

  const items = createMemo<Annotation[]>(() => (comments.data()?.items ?? []).filter((item) => !hidden().has(item.id)));
  const reload = () => comments.invalidate();

  const call = async <T>(request: Promise<Reply>): Promise<T> => {
    const response = await request;
    if (!response.ok) throw await failure(response, options.failedMessage());
    return (await response.json()) as T;
  };
  const one = () => route()[":annotationId"];
  const annotationParam = (id: string) => ({ param: { ...param, annotationId: id } });

  return {
    projection: comments.data,
    items,
    error: comments.error,
    loading: comments.loading,
    refresh: comments.refresh,
    reload,
    hide,
    create: (draft: CommentDraft, offsetHint: number) =>
      call<Annotation>(
        route().$post({
          param,
          json: {
            quote: draft.quote,
            prefix: draft.prefix,
            suffix: draft.suffix,
            offsetHint,
            body: draft.body.trim(),
            suggestion: draft.suggestion,
            idempotencyKey: draft.idempotencyKey,
          },
        }),
      ),
    /** Replies after the ones a comment arrives with. */
    replies: (id: string, cursor: string) =>
      call<{ items: Annotation["replies"]; nextCursor: string | null }>(one().replies.$get({ ...annotationParam(id), query: { cursor } })),
    reply: (id: string, body: string, idempotencyKey: string) =>
      call<unknown>(one().replies.$post({ ...annotationParam(id), json: { body, idempotencyKey } })),
    edit: (id: string, body: string, suggestion?: string | null) =>
      call<unknown>(one().$patch({ ...annotationParam(id), json: suggestion === undefined ? { body } : { body, suggestion } })),
    remove: (id: string) => call<unknown>(one().$delete(annotationParam(id))),
    restore: (id: string) => call<unknown>(one().restore.$post(annotationParam(id))),
    resolve: (id: string, resolved: boolean) => call<unknown>(one().resolve.$post({ ...annotationParam(id), json: { resolved } })),
    /** Accepts the thread's own suggestion, or the one a reply carries. */
    accept: (id: string, operationId: string, expectedText?: string, replyId?: string) =>
      call<{ operationId: string }>(
        one().accept.$post({
          ...annotationParam(id),
          json: { operationId, ...(expectedText === undefined ? {} : { expectedText }), ...(replyId ? { replyId } : {}) },
        }),
      ),
    reject: (id: string, rejected: boolean, replyId?: string) =>
      call<unknown>(one().reject.$post({ ...annotationParam(id), json: { rejected, ...(replyId ? { replyId } : {}) } })),
    undoAccept: (id: string, operationId: string) =>
      call<unknown>(one()["undo-accept"].$post({ ...annotationParam(id), json: { operationId } })),
  };
};
