/**
 * Notebook attachments overview page — `/app/notebooks/<id>/attachments`.
 *
 * Path-based (NOT a `?mode=` query) so the URL stays clean and deep-linkable.
 * Search + pagination via SSR — the SearchBar submits to the same URL with
 * `?search=` set, and the page handler re-renders the filtered grid. KISS:
 * no client-side filter, results stay deterministic.
 */

import { hasRole } from "@k2b/cloud/contracts";
import { type AuthContext, expectUserBackedActor, getDateConfig, getLocale } from "@k2b/cloud/server";
import { get } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { toPublicAttachment } from "@/api/public-resources";
import { notebooksService } from "@/service";
import { ssr } from "../../../config";
import { requestedPresentationMode } from "../../../lib/presentation-url";
import { parseSidebarFilter } from "../../../lib/sidebar-filter";
import { notebooksPageMessages } from "../../messages";
import { buildAttachmentsUrl } from "../../params";
import RememberNotebook from "../_components/RememberNotebook.island";
import { parseFullWidth, parseNavigationHidden, parseSettings } from "../_components/settings/NotebookSettingsStore";
import type { NotebookContext } from "../_components/sidebar/types";
import WorkspaceEventBridge from "../_components/sidebar/WorkspaceEventBridge.island";
import { notebookWorkspaceMessages } from "../messages";
import { loadSidebarWithoutNote, projectNotebook } from "../page-data";
import AttachmentsScreen from "./AttachmentsScreen.island";

const PER_PAGE = 200;

const parsePage = (raw: string | undefined): number => {
  const n = Number.parseInt(raw ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

export default ssr<AuthContext>(async (c) => {
  const t = notebookWorkspaceMessages.resolve([getLocale(c)]).t;
  const printHint = notebooksPageMessages.resolve([getLocale(c)]).t.printHint;
  const user = expectUserBackedActor(c);
  const notebookShortId = c.req.param("id")!;
  const search = (c.req.query("search") ?? "").trim();
  const page = parsePage(c.req.query("page"));

  let notebook = await notebooksService.notebook.getByShortId({ shortId: notebookShortId });
  if (!notebook) return ssr.error(c, 404, { action: { label: "Notebooks", href: "/app/notebooks" } });
  const notebookId = notebook.id;

  const permission = hasRole(user, "admin")
    ? "admin"
    : await notebooksService.notebook.permission.get({
        notebookId,
        userId: user.id,
      });
  if (permission === "none")
    return ssr.error(c, 403, { description: t.accessDeniedDescription, action: { label: "Notebooks", href: "/app/notebooks" } });
  // Readers only use Book; inline attachment links remain available there.
  if (permission === "read") return c.redirect(`/app/notebooks/${notebook.shortId}?mode=book`);

  const cookieHeader = c.req.header("Cookie");
  const settings = parseSettings(cookieHeader, notebook.shortId);

  // Queries in parallel:
  //   1. Filtered + paginated attachments for the grid (current page only)
  //   2. Unfiltered total count for the sidebar's "Attachments" badge —
  //      independent of the active search so the badge always reflects
  //      the notebook's actual size, not the current view.
  const workspaceCursor = await notebooksService.workspaceEvents.latestCursor({ notebookId });
  const [snapshotNotebook, paginatedResult, totalAttachmentCount, tags, favoriteRows, appUrl] = await Promise.all([
    notebooksService.notebook.get({ id: notebookId }),
    notebooksService.attachment.listPaginated({
      notebookId,
      pagination: { page, perPage: PER_PAGE },
      filter: { query: search || undefined },
    }),
    notebooksService.attachment.count({ notebookId }),
    notebooksService.tag.listForNotebook({ notebookId }),
    notebooksService.note.favorites.listIds({ notebookId, userId: user.id }),
    get<string>("app.url"),
  ]);
  if (!snapshotNotebook) return ssr.error(c, 404);
  notebook = snapshotNotebook;
  const publicNotebook = projectNotebook(notebook);
  const sidebarFilter = parseSidebarFilter(new URL(c.req.url).searchParams);
  const sidebar = await loadSidebarWithoutNote({
    notebook,
    userId: user.id,
    sort: settings.treeSort,
    locale: getLocale(c),
    filter: sidebarFilter,
    permission,
  });
  const totalPages = Math.max(1, Math.ceil(paginatedResult.total / paginatedResult.perPage));
  const presentationMode = requestedPresentationMode(new URL(c.req.url).searchParams);
  const baseHref = buildAttachmentsUrl(notebook.shortId, presentationMode);

  const ctx: NotebookContext = {
    notebook: publicNotebook,
    ...sidebar,
    selectedNoteId: null,
    userId: user.id,
    settings,
    navigationHidden: parseNavigationHidden(cookieHeader),
    fullWidth: parseFullWidth(cookieHeader),
    permission,
    attachmentCount: totalAttachmentCount,
    favoriteNoteIds: favoriteRows.map((row) => row.noteId),
    tags,
    workspaceCursor,
    dateConfig: getDateConfig(c),
    sidebarFilter,
    presentationMode,
  };

  return () => (
    <Layout
      printHint={printHint}
      c={c}
      fullPage
      fullWidth
      ui="v2"
      context={{ scope: { type: "notebooks.notebook", id: notebook.shortId } }}
      title={[
        { title: t.start, href: "/" },
        { title: t.notebooks },
        { title: notebook.name, href: `/app/notebooks/${notebook.shortId}` },
        { title: t.attachments },
      ]}
    >
      <RememberNotebook notebookId={notebook.shortId} />
      <WorkspaceEventBridge notebookId={notebook.shortId} appUrl={appUrl} initialCursor={workspaceCursor} />
      <AttachmentsScreen
        ctx={ctx}
        attachments={paginatedResult.items.map((attachment) => toPublicAttachment(attachment, notebook.shortId))}
        total={paginatedResult.total}
        search={search}
        page={paginatedResult.page}
        pages={totalPages}
        baseHref={baseHref}
        graphBack={c.req.path + new URL(c.req.url).search}
        now={new Date().toISOString()}
      />
    </Layout>
  );
});
