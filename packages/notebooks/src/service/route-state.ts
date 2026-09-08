import { extractNamedBlockSummaries, type NamedBlockSummary } from "../lib/named-blocks";
import { hasOnlyNavigatorQuery, parseNavigatorQuery, withNavigatorQuery } from "../lib/navigator-url";
import { extractTaskProgress, extractTocFromMarkdown, type TaskProgress, type TocItem } from "../lib/note-insights";
import { type PresentationMode, resolvePresentationMode } from "../lib/presentation-mode";
import { requestedPresentationMode, withPresentationMode } from "../lib/presentation-url";
import type { Attachment } from "./attachments";
import { notebooksService } from "./index";
import type { Backlink } from "./links";
import type { NoteWithContent } from "./notes";

type PublicAttachment = Omit<Attachment, "shortId">;

export type SelectedNoteRouteState = {
  note: {
    id: string;
    title: string;
    yjsSnapshot: string | null;
    historyIncomplete: boolean;
    contentMd: string | null;
    lockedAt: string | null;
    parentId: string | null;
    createdAt: string;
    updatedAt: string;
    createdBy: string | null;
  };
  readonlyMode: boolean;
  tocItems: TocItem[];
  taskProgress: TaskProgress;
  namedBlocks: NamedBlockSummary[];
  backlinks: Backlink[];
  panelAttachments: PublicAttachment[];
};

export type EditableNoteRouteData = {
  href: string;
  note: {
    id: string;
    title: string;
    yjsSnapshot: string | null;
    historyIncomplete: boolean;
    contentMd: string | null;
    createdAt: string;
    updatedAt: string;
    lockedAt: string | null;
    parentId: string | null;
  };
  detail: {
    noteId: string;
    noteTitle: string;
    contentMd: string | null;
    createdAt: string;
    updatedAt: string;
    lockedAt: string | null;
    historyIncomplete: boolean;
    isLocked: boolean;
    tocItems: TocItem[];
    taskProgress: TaskProgress;
    attachments: PublicAttachment[];
    backlinks: Backlink[];
    namedBlocks: NamedBlockSummary[];
  };
};

export type NotebookRouteStateResponse =
  | { kind: "ok"; state: EditableNoteRouteData }
  | { kind: "fallback"; reason: "invalid-target" | "not-found" | "readonly" };

type LoadSelectedNoteParams = {
  notebookId: string;
  notebookShortId: string;
  noteId: string;
  canWrite: boolean;
  userId: string;
  bypassAccess: boolean;
};

const toSelectedNote = async (note: NoteWithContent): Promise<SelectedNoteRouteState["note"]> => ({
  id: note.shortId,
  title: note.title,
  yjsSnapshot: note.yjsSnapshot,
  historyIncomplete: note.historyIncomplete,
  contentMd: note.contentMd,
  lockedAt: note.lockedAt,
  parentId: note.parentId
    ? ((await notebooksService.note.resolveIdsToShortIds({ ids: [note.parentId] })).get(note.parentId) ?? null)
    : null,
  createdAt: note.createdAt,
  updatedAt: note.updatedAt,
  createdBy: note.createdBy,
});

export const loadSelectedNoteRouteState = async (params: LoadSelectedNoteParams): Promise<SelectedNoteRouteState | null> => {
  const note = await notebooksService.note.getWithContentByShortId({ shortId: params.noteId });
  if (!note || note.notebookId !== params.notebookId) return null;

  const readonlyMode = !params.canWrite || !!note.lockedAt;
  const tocItems = extractTocFromMarkdown(note.contentMd);
  const taskProgress = extractTaskProgress(note.contentMd);
  const namedBlocks = extractNamedBlockSummaries(note.contentMd);

  const attachmentShortIds = notebooksService.attachment.extractIds(note.contentMd);
  const [referencedAttachments, backlinks] = await Promise.all([
    attachmentShortIds.length > 0
      ? notebooksService.attachment.listByShortIds({ shortIds: attachmentShortIds, notebookId: params.notebookId })
      : Promise.resolve([]),
    notebooksService.note.backlinks.list({
      noteId: note.id,
      userId: params.userId,
      bypassAccess: params.bypassAccess,
    }),
  ]);

  return {
    note: await toSelectedNote(note),
    readonlyMode,
    tocItems,
    taskProgress,
    namedBlocks,
    backlinks,
    panelAttachments: referencedAttachments.map((attachment) => ({
      id: attachment.shortId,
      notebookId: params.notebookShortId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      kind: attachment.kind,
      createdBy: attachment.createdBy,
      createdAt: attachment.createdAt,
    })),
  };
};

type ResolveEditableRouteParams = Omit<LoadSelectedNoteParams, "noteId"> & {
  href: string;
  origin: string;
  defaultPresentationMode: PresentationMode;
};

const parseSameNotebookNoteHref = (
  params: ResolveEditableRouteParams,
): { noteId: string; hrefQuery: ReturnType<typeof parseNavigatorQuery>; requestedMode?: PresentationMode } | null => {
  try {
    const url = new URL(params.href, params.origin);
    const requestedMode = requestedPresentationMode(url.searchParams);
    const navigatorParams = new URLSearchParams(url.searchParams);
    if (requestedMode) navigatorParams.delete("mode");
    if (url.origin !== params.origin || url.hash || !hasOnlyNavigatorQuery(navigatorParams)) return null;
    const match = url.pathname.match(/^\/app\/notebooks\/([^/]+)\/notes\/([^/]+)$/);
    if (!match || decodeURIComponent(match[1]!) !== params.notebookShortId) return null;
    const noteId = decodeURIComponent(match[2]!);
    if (!/^[A-Za-z0-9]{6}$/.test(noteId)) return null;
    return {
      noteId,
      hrefQuery: parseNavigatorQuery(url.searchParams),
      requestedMode,
    };
  } catch {
    return null;
  }
};

export const loadEditableNoteRouteData = async (params: ResolveEditableRouteParams): Promise<NotebookRouteStateResponse> => {
  const target = parseSameNotebookNoteHref(params);
  if (!target) return { kind: "fallback", reason: "invalid-target" };

  // Only the existing Write workspace can apply this payload. Book and Read-only
  // fall back to a full server load instead of mounting into an editable owner.
  if (
    resolvePresentationMode({
      permission: params.canWrite ? "write" : "read",
      requestedMode: target.requestedMode,
      defaultPresentationMode: params.defaultPresentationMode,
      locked: false,
    }) !== "write"
  ) {
    return { kind: "fallback", reason: "readonly" };
  }

  const state = await loadSelectedNoteRouteState({ ...params, noteId: target.noteId });
  if (!state) return { kind: "fallback", reason: "not-found" };
  if (state.readonlyMode) return { kind: "fallback", reason: "readonly" };

  const noteHref = withNavigatorQuery(
    `/app/notebooks/${encodeURIComponent(params.notebookShortId)}/notes/${encodeURIComponent(state.note.id)}`,
    target.hrefQuery,
  );
  const href = target.requestedMode ? withPresentationMode(noteHref, target.requestedMode) : noteHref;
  return {
    kind: "ok",
    state: {
      href,
      note: {
        id: state.note.id,
        title: state.note.title,
        yjsSnapshot: state.note.yjsSnapshot,
        historyIncomplete: state.note.historyIncomplete,
        contentMd: state.note.contentMd,
        createdAt: state.note.createdAt,
        updatedAt: state.note.updatedAt,
        lockedAt: state.note.lockedAt,
        parentId: state.note.parentId,
      },
      detail: {
        noteId: state.note.id,
        noteTitle: state.note.title,
        contentMd: state.note.contentMd,
        createdAt: state.note.createdAt,
        updatedAt: state.note.updatedAt,
        lockedAt: state.note.lockedAt,
        historyIncomplete: state.note.historyIncomplete,
        isLocked: false,
        tocItems: state.tocItems,
        taskProgress: state.taskProgress,
        attachments: state.panelAttachments,
        backlinks: state.backlinks,
        namedBlocks: state.namedBlocks,
      },
    },
  };
};
