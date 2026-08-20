/**
 * Notebook attachments overview page — `/app/notebooks/<id>/attachments`.
 *
 * Path-based (NOT a `?mode=` query) so the URL stays clean and deep-linkable.
 * Search + pagination via SSR — the SearchBar submits to the same URL with
 * `?search=` set, and the page handler re-renders the filtered grid. KISS:
 * no client-side filter, results stay deterministic.
 */

import { AppWorkspace, Pagination, Placeholder } from "@k2b/ui";
import { type AuthContext, expectUserBackedActor, getDateConfig } from "@valentinkolb/cloud/server";
import { get } from "@valentinkolb/cloud/services";
import { Layout } from "@valentinkolb/cloud/ssr";
import { SearchBar } from "@valentinkolb/cloud/ssr/islands";
import { toPublicAttachment } from "@/api/public-resources";
import { notebooksService } from "@/service";
import { ssr } from "../../../config";
import { buildAttachmentsUrl } from "../../params";
import AttachmentsOverview from "../_components/attachments-overview/AttachmentsOverview.island";
import { parseSettings } from "../_components/settings/NotebookSettingsStore";
import NotebookSidebar from "../_components/sidebar/NotebookSidebar.island";
import type { NotebookContext } from "../_components/sidebar/types";
import WorkspaceEventBridge from "../_components/sidebar/WorkspaceEventBridge.island";
import { projectNotebook, projectTree } from "../page-data";

const PER_PAGE = 200;

const parsePage = (raw: string | undefined): number => {
  const n = Number.parseInt(raw ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

export default ssr<AuthContext>(async (c) => {
  const user = expectUserBackedActor(c);
  const notebookShortId = c.req.param("id")!;
  const search = (c.req.query("search") ?? "").trim();
  const page = parsePage(c.req.query("page"));

  let notebook = await notebooksService.notebook.getByShortId({ shortId: notebookShortId });
  if (!notebook) {
    return () => (
      <Layout c={c} title="Not Found">
        <div class="max-w-md mx-auto mt-16">
          <Placeholder surface="paper" state="error" icon="ti ti-alert-circle" title="Notebook not found" />
        </div>
      </Layout>
    );
  }
  const notebookId = notebook.id;

  const permission = await notebooksService.notebook.permission.get({
    notebookId,
    userId: user.id,
  });
  if (permission === "none") {
    return () => (
      <Layout c={c} title="Access Denied">
        <div class="max-w-md mx-auto mt-16">
          <Placeholder
            surface="paper"
            state="error"
            icon="ti ti-lock"
            title="Access denied"
            description="You don't have access to this notebook."
          />
        </div>
      </Layout>
    );
  }

  const cookieHeader = c.req.header("Cookie");
  const settings = parseSettings(cookieHeader, notebook.shortId);

  // Three queries in parallel:
  //   1. Note tree for the sidebar
  //   2. Filtered + paginated attachments for the grid (current page only)
  //   3. Unfiltered total count for the sidebar's "Attachments" badge —
  //      independent of the active search so the badge always reflects
  //      the notebook's actual size, not the current view.
  const workspaceCursor = await notebooksService.workspaceEvents.latestCursor({ notebookId });
  const [snapshotNotebook, tree, paginatedResult, totalAttachmentCount, tags, favoriteRows, appUrl] = await Promise.all([
    notebooksService.notebook.get({ id: notebookId }),
    notebooksService.note.getTree({ notebookId }),
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
  if (!snapshotNotebook) {
    return () => (
      <Layout c={c} title="Not Found">
        <Placeholder surface="paper" state="error" icon="ti ti-alert-circle" title="Notebook not found" />
      </Layout>
    );
  }
  notebook = snapshotNotebook;
  const publicNotebook = projectNotebook(notebook);
  const publicTree = projectTree(tree, notebook.shortId);
  const totalPages = Math.max(1, Math.ceil(paginatedResult.total / paginatedResult.perPage));
  const baseHref = buildAttachmentsUrl(notebook.shortId);
  const paginationBaseUrl = search ? `${baseHref}?search=${encodeURIComponent(search)}&page=` : `${baseHref}?page=`;

  const ctx: NotebookContext = {
    notebook: publicNotebook,
    tree: publicTree,
    selectedNoteId: null,
    userId: user.id,
    settings,
    permission,
    attachmentCount: totalAttachmentCount,
    favoriteNoteIds: favoriteRows.map((row) => row.noteId),
    tags,
    workspaceCursor,
    dateConfig: getDateConfig(c),
    navigatorQuery: {},
  };

  return () => (
    <Layout
      c={c}
      fullPage
      title={[
        { title: "Start", href: "/" },
        { title: "Notebooks", href: "/app/notebooks" },
        { title: notebook.name, href: `/app/notebooks/${notebook.shortId}` },
        { title: "Attachments" },
      ]}
    >
      <AppWorkspace class="flex-1 min-h-0">
        <WorkspaceEventBridge notebookId={notebook.shortId} appUrl={appUrl} initialCursor={workspaceCursor} />
        <NotebookSidebar ctx={ctx} />
        <AppWorkspace.Content>
          <AppWorkspace.Main class="flex-col p-[var(--ui-space-shell)]" scroll={false}>
            {/* Search bar across the full content width. The breadcrumb already
                labels the page — no additional title above. */}
            <SearchBar value={search} action={baseHref} placeholder="Search attachments…" ariaLabel="Search attachments" />

            <div class="mt-2 flex-1 min-h-0 overflow-y-auto flex flex-col gap-2">
              <AttachmentsOverview
                notebookId={notebook.shortId}
                initial={paginatedResult.items.map((attachment) => toPublicAttachment(attachment, notebook.shortId))}
                searchQuery={search}
              />
              <Pagination currentPage={paginatedResult.page} totalPages={totalPages} baseUrl={paginationBaseUrl} />
            </div>
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </Layout>
  );
});
