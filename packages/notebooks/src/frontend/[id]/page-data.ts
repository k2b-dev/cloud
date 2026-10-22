import { hasRole } from "@k2b/cloud/contracts";
import { type AuthContext, expectUserBackedActor, getDateConfig, getLocale } from "@k2b/cloud/server";
import { get } from "@k2b/cloud/services";
import type { Context } from "hono";
import { toPublicNotebook, toPublicNoteComment } from "@/api/public-resources";
import { orderBookTree } from "@/lib/book-tree";
import { extractNamedBlockSummaries } from "@/lib/named-blocks";
import { isPresentationMode, type PresentationMode, resolvePresentationMode } from "@/lib/presentation-mode";
import { requestedPresentationMode } from "@/lib/presentation-url";
import { parseSidebarFilter } from "@/lib/sidebar-filter";
import { notebooksService } from "@/service";
import { loadBookNote } from "@/service/book";
import { loadSelectedNoteRouteState, type SelectedNoteRouteState } from "@/service/route-state";
import { buildNoteUrl } from "../params";
import { extractTocFromMarkdown } from "./_components/detail/toc";
import { parseGraphViewState } from "./_components/graph/view-state";
import { parseDetailPanelOpen, parseFullWidth, parseNavigationHidden, parseSettings } from "./_components/settings/NotebookSettingsStore";
import type { NotebookContext } from "./_components/sidebar/types";

type SelectedNote = SelectedNoteRouteState["note"];
type PageOptions = {
  title?: string;
  description?: string;
  theme?: "light" | "dark";
};
type NotebookPageContext = Context<AuthContext & { Variables: { page: Partial<PageOptions> } }>;

export async function loadNotebookPageData(c: NotebookPageContext) {
  const user = expectUserBackedActor(c);
  const notebookShortId = c.req.param("id")!;

  let notebook = await notebooksService.notebook.getByShortId({ shortId: notebookShortId });
  if (!notebook) return { kind: "not_found" as const };

  const notebookId = notebook.id;
  const permission = hasRole(user, "admin")
    ? "admin"
    : await notebooksService.notebook.permission.get({
        notebookId,
        userId: user.id,
      });
  if (permission === "none") return { kind: "access_denied" as const };

  const isAdmin = permission === "admin";
  const canWrite = permission === "write" || isAdmin;
  const mode = c.req.query("mode");
  const isVersionsMode = canWrite && mode === "versions";
  const isGraphMode = mode === "graph";
  const from = c.req.query("from");
  const graphFrom = isGraphMode ? (permission === "read" ? "book" : isPresentationMode(from) ? from : undefined) : undefined;
  const graphShell = isGraphMode ? (graphFrom === "book" ? "book" : "workspace") : undefined;
  // Capture before the snapshot. Events published while the snapshot loads may
  // replay redundantly, but an event can never be skipped between SSR and the
  // browser subscription.
  const workspaceCursor = await notebooksService.workspaceEvents.latestCursor({ notebookId });
  const snapshotNotebook = await notebooksService.notebook.get({ id: notebookId });
  if (!snapshotNotebook) return { kind: "not_found" as const };
  notebook = snapshotNotebook;
  const graphBack = isGraphMode ? parseGraphBack(c.req.query("back"), notebook.shortId) : undefined;
  const locale = getLocale(c);
  const internalTree = await notebooksService.note.getTree({ notebookId, locale });
  const tree = projectTree(internalTree, notebook.shortId);
  const publicNotebook = projectNotebook(notebook);
  // A lock only turns Write into Read-only, so Book is known before a note is chosen.
  const isBookMode =
    resolvePresentationMode({ permission, requestedMode: mode, defaultPresentationMode: notebook.defaultPresentationMode }) === "book" &&
    !isVersionsMode &&
    !isGraphMode;
  const bookTree =
    isBookMode || graphShell === "book" ? orderBookTree(tree, { id: (node) => node.id, homeId: notebook.homepageNoteShortId, locale }) : [];

  const cookieHeader = c.req.header("Cookie");
  const settings = parseSettings(cookieHeader, notebook.shortId);
  const detailPanelOpen = parseDetailPanelOpen(cookieHeader);
  const noteParam = c.req.param("noteId");
  const selectedNoteId = await resolveSelectedNoteId({
    notebookId,
    noteParam,
    graphNoteParam: isGraphMode ? c.req.query("note") : undefined,
    lastNoteId: settings.lastNoteId,
    homepageNoteId: notebook.homepageNoteShortId,
    // Book opens where its sidebar starts.
    firstNoteId: (isBookMode || graphShell === "book" ? bookTree : tree)[0]?.id ?? null,
  });
  if (noteParam && !selectedNoteId) return { kind: "not_found" as const };

  const selected = await loadSelectedNote({
    notebookId,
    notebookShortId: notebook.shortId,
    selectedNoteId,
    isVersionsMode,
    canWrite,
    userId: user.id,
    bypassAccess: hasRole(user, "admin"),
    permission,
    requestedMode: mode,
    defaultPresentationMode: notebook.defaultPresentationMode,
    locale,
  });
  if (noteParam && !selected.note) return { kind: "not_found" as const };

  if (!noteParam && selected.note && !isGraphMode) {
    return {
      kind: "redirect" as const,
      href: `${buildNoteUrl(notebook.shortId, selected.note.id)}${new URL(c.req.url).search}`,
    };
  }

  const presentationMode = resolvePresentationMode({
    permission,
    requestedMode: mode,
    defaultPresentationMode: notebook.defaultPresentationMode,
    locked: !!selected.note?.lockedAt,
  });
  const readonlyMode = presentationMode !== "write";
  const graph = isGraphMode ? await notebooksService.notebook.graph({ notebookId }) : null;
  const versionHistory =
    isVersionsMode && selected.note && selected.internalNoteId
      ? await notebooksService.note.versions
          .list({
            noteId: selected.internalNoteId,
            pagination: { page: 1, perPage: 20, offset: 0 },
          })
          .catch(() => null)
      : null;
  const publicVersionHistory = versionHistory
    ? { ...versionHistory, versions: versionHistory.versions.map((version) => ({ ...version, noteId: selected.note!.id })) }
    : null;
  const selectedCommentNote =
    selected.note && !isVersionsMode && !isGraphMode && !isBookMode
      ? await notebooksService.note.getByShortId({ shortId: selected.note.id })
      : null;
  const [attachmentCount, tags, favoriteRows, commentsPage] = await Promise.all([
    notebooksService.attachment.count({ notebookId }),
    notebooksService.tag.listForNotebook({ notebookId }),
    notebooksService.note.favorites.listIds({ notebookId, userId: user.id }),
    selectedCommentNote?.notebookId === notebookId
      ? notebooksService.note.comments.listPage({
          notebookId,
          noteId: selectedCommentNote.id,
          viewerUserId: user.id,
          pagination: { page: 1, perPage: 30 },
        })
      : Promise.resolve(null),
  ]);
  const initialCommentsPage =
    commentsPage && selected.note
      ? {
          ...commentsPage,
          items: commentsPage.items.map((comment) => toPublicNoteComment(comment, notebook.shortId, selected.note!.id)),
        }
      : null;

  const ctx: NotebookContext = {
    notebook: publicNotebook,
    tree,
    selectedNoteId,
    userId: user.id,
    settings,
    navigationHidden: parseNavigationHidden(cookieHeader),
    fullWidth: parseFullWidth(cookieHeader),
    permission,
    attachmentCount,
    favoriteNoteIds: favoriteRows.map((row) => row.noteId),
    tags,
    workspaceCursor,
    dateConfig: getDateConfig(c),
    sidebarFilter: parseSidebarFilter(new URL(c.req.url).searchParams),
    presentationMode: isGraphMode ? graphFrom : requestedPresentationMode(new URL(c.req.url).searchParams),
  };

  const appUrl = await get<string>("app.url");
  const requestUrl = new URL(c.req.url);

  return {
    kind: "ok" as const,
    user,
    notebook: publicNotebook,
    tree,
    permission,
    canWrite,
    isVersionsMode,
    isGraphMode,
    graphFrom,
    graphShell,
    graphBack,
    graphView: isGraphMode ? parseGraphViewState(new URL(c.req.url).searchParams) : undefined,
    /** One base for relative dates, so the server render and the browser show the same text. */
    now: new Date().toISOString(),
    selectedNoteId,
    selectedNote: selected.note,
    selectedRouteState: selected.routeState,
    tocItems: selected.tocItems,
    namedBlocks: selected.namedBlocks,
    readonlyMode,
    presentationMode,
    isBookMode,
    bookTree,
    bookHtml: selected.bookHtml,
    graph,
    versionHistory: publicVersionHistory,
    ctx,
    appUrl,
    currentHref: `${requestUrl.pathname}${requestUrl.search}`,
    detailPanelOpen,
    showDetailPanel: !!selected.note && !isVersionsMode && !isGraphMode && !isBookMode,
    panelAttachments: selected.routeState?.panelAttachments ?? [],
    backlinks: selected.routeState?.backlinks ?? [],
    initialCommentsPage,
    dateConfig: ctx.dateConfig,
  };
}

function parseGraphBack(back: string | undefined, notebookShortId: string): string | undefined {
  if (!back?.startsWith("/") || back.startsWith("//") || back.startsWith("/\\")) return undefined;
  try {
    const url = new URL(back, "https://notebooks.invalid");
    const notebookPath = `/app/notebooks/${notebookShortId}`;
    if (url.origin !== "https://notebooks.invalid" || (url.pathname !== notebookPath && !url.pathname.startsWith(`${notebookPath}/`))) {
      return undefined;
    }
    return url.pathname + url.search;
  } catch {
    return undefined;
  }
}

async function resolveSelectedNoteId(params: {
  notebookId: string;
  noteParam: string | undefined;
  graphNoteParam: string | undefined;
  lastNoteId: string | null;
  homepageNoteId: string | null;
  firstNoteId: string | null;
}): Promise<string | null> {
  const resolveNoteInNotebook = async (shortId: string | null | undefined): Promise<string | null> => {
    if (!shortId) return null;
    const note = await notebooksService.note.getByShortId({ shortId });
    return note?.notebookId === params.notebookId ? note.shortId : null;
  };

  const resolvedFromPath = await resolveNoteInNotebook(params.noteParam);
  // An explicit link must never display another note under the requested URL.
  if (params.noteParam) return resolvedFromPath;
  const resolvedFromGraph = await resolveNoteInNotebook(params.graphNoteParam);
  if (resolvedFromGraph) return resolvedFromGraph;
  const resolvedFromCookie = await resolveNoteInNotebook(params.lastNoteId);
  const resolvedHomepage = await resolveNoteInNotebook(params.homepageNoteId);
  return resolvedFromPath ?? resolvedFromCookie ?? resolvedHomepage ?? params.firstNoteId;
}

async function loadSelectedNote(params: {
  notebookId: string;
  notebookShortId: string;
  selectedNoteId: string | null;
  isVersionsMode: boolean;
  canWrite: boolean;
  userId: string;
  bypassAccess: boolean;
  permission: string;
  requestedMode: string | undefined;
  defaultPresentationMode: PresentationMode;
  locale: string;
}): Promise<{
  internalNoteId: string | null;
  note: SelectedNote | null;
  routeState: SelectedNoteRouteState | null;
  tocItems: ReturnType<typeof extractTocFromMarkdown>;
  namedBlocks: ReturnType<typeof extractNamedBlockSummaries>;
  bookHtml: string | null;
}> {
  if (!params.selectedNoteId) {
    return { internalNoteId: null, note: null, routeState: null, tocItems: [], namedBlocks: [], bookHtml: null };
  }

  const presentationMode = resolvePresentationMode({
    permission: params.permission,
    requestedMode: params.requestedMode,
    defaultPresentationMode: params.defaultPresentationMode,
    locked: false,
  });
  if (presentationMode === "book" && !params.isVersionsMode && params.requestedMode !== "graph") {
    const book = await loadBookNote({
      notebookId: params.notebookId,
      notebookShortId: params.notebookShortId,
      noteShortId: params.selectedNoteId,
      userId: params.userId,
      locale: params.locale,
      bypassAccess: params.bypassAccess,
    });
    if (!book) return { internalNoteId: null, note: null, routeState: null, tocItems: [], namedBlocks: [], bookHtml: null };
    return {
      internalNoteId: book.note.id,
      note: {
        id: book.note.shortId,
        title: book.note.title,
        contentMd: null,
        yjsSnapshot: null,
        yjsRestoreRevision: null,
        historyIncomplete: book.note.historyIncomplete,
        lockedAt: book.note.lockedAt,
        parentId: null,
        createdAt: book.note.createdAt,
        updatedAt: book.note.updatedAt,
        createdBy: book.note.createdBy,
      },
      routeState: null,
      tocItems: [],
      namedBlocks: [],
      bookHtml: book.document.html,
    };
  }

  if (params.requestedMode === "graph") {
    const note = await notebooksService.note.getByShortId({ shortId: params.selectedNoteId });
    if (note?.notebookId !== params.notebookId) {
      return { internalNoteId: null, note: null, routeState: null, tocItems: [], namedBlocks: [], bookHtml: null };
    }
    return {
      internalNoteId: note.id,
      note: {
        id: note.shortId,
        title: note.title,
        lockedAt: note.lockedAt,
        historyIncomplete: note.historyIncomplete,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        createdBy: note.createdBy,
        parentId: null,
        contentMd: null,
        yjsSnapshot: null,
        yjsRestoreRevision: null,
      },
      routeState: null,
      tocItems: [],
      namedBlocks: [],
      bookHtml: null,
    };
  }

  if (params.isVersionsMode) {
    const noteMeta = await notebooksService.note.getByShortId({ shortId: params.selectedNoteId });
    if (noteMeta?.notebookId !== params.notebookId) {
      return { internalNoteId: null, note: null, routeState: null, tocItems: [], namedBlocks: [], bookHtml: null };
    }
    const note = {
      id: noteMeta.shortId,
      title: noteMeta.title,
      historyIncomplete: noteMeta.historyIncomplete,
      yjsSnapshot: null,
      yjsRestoreRevision: null,
      contentMd: noteMeta.contentMd,
      lockedAt: noteMeta.lockedAt,
      parentId: noteMeta.parentId
        ? ((await notebooksService.note.resolveIdsToShortIds({ ids: [noteMeta.parentId] })).get(noteMeta.parentId) ?? null)
        : null,
      createdAt: noteMeta.createdAt,
      updatedAt: noteMeta.updatedAt,
      createdBy: noteMeta.createdBy,
    };
    return {
      internalNoteId: noteMeta.id,
      note,
      routeState: null,
      tocItems: extractTocFromMarkdown(noteMeta.contentMd),
      namedBlocks: extractNamedBlockSummaries(noteMeta.contentMd),
      bookHtml: null,
    };
  }

  const routeState = await loadSelectedNoteRouteState({
    notebookId: params.notebookId,
    notebookShortId: params.notebookShortId,
    noteId: params.selectedNoteId,
    canWrite: params.canWrite,
    userId: params.userId,
    bypassAccess: params.bypassAccess,
  });
  if (!routeState) return { internalNoteId: null, note: null, routeState: null, tocItems: [], namedBlocks: [], bookHtml: null };
  return {
    internalNoteId: null,
    note: routeState.note,
    routeState,
    tocItems: routeState.tocItems,
    namedBlocks: routeState.namedBlocks,
    bookHtml: null,
  };
}

export const projectNotebook = toPublicNotebook;

export function projectTree(
  nodes: Awaited<ReturnType<typeof notebooksService.note.getTree>>,
  notebookShortId: string,
): NotebookContext["tree"] {
  const byUuid = new Map<string, string>();
  const index = (items: typeof nodes): void => {
    for (const item of items) {
      byUuid.set(item.id, item.shortId);
      index(item.children);
    }
  };
  index(nodes);
  const project = (items: typeof nodes): NotebookContext["tree"] =>
    items.map((item) => ({
      id: item.shortId,
      notebookId: notebookShortId,
      parentId: item.parentId ? (byUuid.get(item.parentId) ?? null) : null,
      title: item.title,
      position: item.position,
      hasChildren: item.hasChildren,
      yjsSnapshotAt: item.yjsSnapshotAt,
      contentMd: item.contentMd,
      createdBy: item.createdBy,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      lockedAt: item.lockedAt,
      children: project(item.children),
    }));
  return project(nodes);
}
