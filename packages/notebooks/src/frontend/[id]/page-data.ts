import { hasRole } from "@valentinkolb/cloud/contracts";
import { type AuthContext, expectUserBackedActor, getDateConfig } from "@valentinkolb/cloud/server";
import { get } from "@valentinkolb/cloud/services";
import type { Context } from "hono";
import { toPublicNoteComment, toPublicNotebook } from "@/api/public-resources";
import { extractNamedBlockSummaries } from "@/lib/named-blocks";
import { parseNavigatorQuery } from "@/lib/navigator-url";
import { notebooksService } from "@/service";
import { loadSelectedNoteRouteState, type SelectedNoteRouteState } from "@/service/route-state";
import { buildNoteUrl, buildVersionsUrl } from "../params";
import { extractTocFromMarkdown } from "./_components/detail/toc";
import { parseDetailPanelOpen, parseSettings } from "./_components/settings/NotebookSettingsStore";
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
  const permission = await notebooksService.notebook.permission.get({
    notebookId,
    userId: user.id,
  });
  if (permission === "none") return { kind: "access_denied" as const };

  const isAdmin = permission === "admin";
  const canWrite = permission === "write" || isAdmin;
  const mode = c.req.query("mode");
  const isVersionsMode = mode === "versions";
  const isGraphMode = mode === "graph";
  // Capture before the snapshot. Events published while the snapshot loads may
  // replay redundantly, but an event can never be skipped between SSR and the
  // browser subscription.
  const workspaceCursor = await notebooksService.workspaceEvents.latestCursor({ notebookId });
  const snapshotNotebook = await notebooksService.notebook.get({ id: notebookId });
  if (!snapshotNotebook) return { kind: "not_found" as const };
  notebook = snapshotNotebook;
  const internalTree = await notebooksService.note.getTree({ notebookId });
  const tree = projectTree(internalTree, notebook.shortId);
  const publicNotebook = projectNotebook(notebook);

  const cookieHeader = c.req.header("Cookie");
  const settings = parseSettings(cookieHeader, notebook.shortId);
  const detailPanelOpen = parseDetailPanelOpen(cookieHeader);
  const noteParam = c.req.param("noteId");
  const selectedNoteId = await resolveSelectedNoteId({
    notebookId,
    noteParam,
    lastNoteId: settings.lastNoteId,
    homepageNoteId: notebook.homepageNoteShortId,
    firstNoteId: tree[0]?.id ?? null,
  });

  const selected = await loadSelectedNote({
    notebookId,
    notebookShortId: notebook.shortId,
    selectedNoteId,
    isVersionsMode,
    canWrite,
    userId: user.id,
    bypassAccess: hasRole(user, "admin"),
  });

  if (!noteParam && selected.note && !isGraphMode) {
    return {
      kind: "redirect" as const,
      href: isVersionsMode ? buildVersionsUrl(notebook.shortId, selected.note.id) : buildNoteUrl(notebook.shortId, selected.note.id),
    };
  }

  const readonlyMode = selected.routeState?.readonlyMode ?? (!canWrite || !!selected.note?.lockedAt);
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
  const selectedCommentNote = selected.note && !isVersionsMode && !isGraphMode
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
    permission,
    attachmentCount,
    favoriteNoteIds: favoriteRows.map((row) => row.noteId),
    tags,
    workspaceCursor,
    dateConfig: getDateConfig(c),
    navigatorQuery: parseNavigatorQuery(new URL(c.req.url).searchParams),
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
    canRunScripts: notebook.scriptsEnabled,
    isVersionsMode,
    isGraphMode,
    selectedNoteId,
    selectedNote: selected.note,
    selectedRouteState: selected.routeState,
    tocItems: selected.tocItems,
    namedBlocks: selected.namedBlocks,
    readonlyMode,
    graph,
    versionHistory: publicVersionHistory,
    ctx,
    appUrl,
    currentHref: `${requestUrl.pathname}${requestUrl.search}`,
    detailPanelOpen,
    showDetailPanel: !!selected.note && !isVersionsMode && !isGraphMode,
    panelAttachments: selected.routeState?.panelAttachments ?? [],
    backlinks: selected.routeState?.backlinks ?? [],
    initialCommentsPage,
    dateConfig: ctx.dateConfig,
  };
}

async function resolveSelectedNoteId(params: {
  notebookId: string;
  noteParam: string | undefined;
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
}): Promise<{
  internalNoteId: string | null;
  note: SelectedNote | null;
  routeState: SelectedNoteRouteState | null;
  tocItems: ReturnType<typeof extractTocFromMarkdown>;
  namedBlocks: ReturnType<typeof extractNamedBlockSummaries>;
}> {
  if (!params.selectedNoteId) {
    return { internalNoteId: null, note: null, routeState: null, tocItems: [], namedBlocks: [] };
  }

  if (params.isVersionsMode) {
    const noteMeta = await notebooksService.note.getByShortId({ shortId: params.selectedNoteId });
    if (noteMeta?.notebookId !== params.notebookId) {
      return { internalNoteId: null, note: null, routeState: null, tocItems: [], namedBlocks: [] };
    }
    const note = {
      id: noteMeta.shortId,
      title: noteMeta.title,
      yjsSnapshot: null,
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
  if (!routeState) return { internalNoteId: null, note: null, routeState: null, tocItems: [], namedBlocks: [] };
  return {
    internalNoteId: null,
    note: routeState.note,
    routeState,
    tocItems: routeState.tocItems,
    namedBlocks: routeState.namedBlocks,
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
