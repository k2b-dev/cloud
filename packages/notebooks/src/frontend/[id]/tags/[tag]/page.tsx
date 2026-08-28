/**
 * Per-tag notes page — `/app/notebooks/<id>/tags/<tag>`.
 *
 * Lists every note that references `#<tag>`, with previews + a SSR
 * search bar. Search filter mirrors the attachments overview pattern:
 * the `SearchBar` submits to the same URL with `?search=`, the page
 * handler re-renders, no client-side filtering.
 */

import { AppWorkspace, Pagination, Placeholder } from "@k2b/ui";
import { type AuthContext, expectUserBackedActor, getDateConfig, getLocale } from "@valentinkolb/cloud/server";
import { get } from "@valentinkolb/cloud/services";
import { Layout } from "@valentinkolb/cloud/ssr";
import { SearchBar } from "@valentinkolb/cloud/ssr/islands";
import { notebooksService } from "@/service";
import { ssr } from "../../../../config";
import { buildNoteUrl, buildTagPageUrl } from "../../../params";
import { parseSettings } from "../../_components/settings/NotebookSettingsStore";
import NotebookSidebar from "../../_components/sidebar/NotebookSidebar.island";
import type { NotebookContext } from "../../_components/sidebar/types";
import WorkspaceEventBridge from "../../_components/sidebar/WorkspaceEventBridge.island";
import { projectNotebook, projectTree } from "../../page-data";
import { notebookWorkspaceMessages } from "../../messages";

const PER_PAGE = 50;

const parsePage = (raw: string | undefined): number => {
  const n = Number.parseInt(raw ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const t = notebookWorkspaceMessages.resolve([locale]).t;
  const formatDate = (iso: string): string => new Intl.DateTimeFormat(locale).format(new Date(iso));
  const user = expectUserBackedActor(c);
  const notebookShortId = c.req.param("id")!;
  const tagParam = (c.req.param("tag") ?? "").toLowerCase();
  const search = (c.req.query("search") ?? "").trim();
  const page = parsePage(c.req.query("page"));

  let notebook = await notebooksService.notebook.getByShortId({ shortId: notebookShortId });
  const notebookId = notebook?.id;
  if (!notebook || !notebookId) {
    return () => (
      <Layout c={c} title={t.notFound}>
        <div class="max-w-md mx-auto mt-16">
          <Placeholder surface="paper" state="error" icon="ti ti-alert-circle" title={t.notebookNotFound} />
        </div>
      </Layout>
    );
  }

  const permission = await notebooksService.notebook.permission.get({
    notebookId,
    userId: user.id,
  });
  if (permission === "none") {
    return () => (
      <Layout c={c} title={t.accessDenied}>
        <div class="max-w-md mx-auto mt-16">
          <Placeholder
            surface="paper"
            state="error"
            icon="ti ti-lock"
            title={t.accessDenied}
            description={t.accessDeniedDescription}
          />
        </div>
      </Layout>
    );
  }

  const cookieHeader = c.req.header("Cookie");
  const settings = parseSettings(cookieHeader, notebook.shortId);

  // Four parallel queries:
  //   1. Note tree for sidebar
  //   2. Page of notes-with-tag (filtered by ?search if any)
  //   3. Total notes-with-tag (unfiltered) for the header counter
  //   4. Sidebar badge counts
  const workspaceCursor = await notebooksService.workspaceEvents.latestCursor({ notebookId });
  const [snapshotNotebook, tree, paginatedResult, totalNotesForTag, attachmentCount, tags, favoriteRows, appUrl] = await Promise.all([
    notebooksService.notebook.get({ id: notebookId }),
    notebooksService.note.getTree({ notebookId }),
    notebooksService.tag.listNotesForTag({
      notebookId,
      tag: tagParam,
      search: search || undefined,
      pagination: { limit: PER_PAGE, offset: (page - 1) * PER_PAGE },
    }),
    notebooksService.tag.countNotesForTag({ notebookId, tag: tagParam }),
    notebooksService.attachment.count({ notebookId }),
    notebooksService.tag.listForNotebook({ notebookId }),
    notebooksService.note.favorites.listIds({ notebookId, userId: user.id }),
    get<string>("app.url"),
  ]);
  if (!snapshotNotebook) {
    return () => (
      <Layout c={c} title={t.notFound}>
        <Placeholder surface="paper" state="error" icon="ti ti-alert-circle" title={t.notebookNotFound} />
      </Layout>
    );
  }
  notebook = snapshotNotebook;
  const publicNotebook = projectNotebook(notebook);
  const publicTree = projectTree(tree, notebook.shortId);
  const totalPages = Math.max(1, Math.ceil(paginatedResult.total / PER_PAGE));
  const baseHref = buildTagPageUrl(notebook.shortId, tagParam);
  const paginationBaseUrl = search ? `${baseHref}?search=${encodeURIComponent(search)}&page=` : `${baseHref}?page=`;

  const ctx: NotebookContext = {
    notebook: publicNotebook,
    tree: publicTree,
    selectedNoteId: null,
    userId: user.id,
    settings,
    permission,
    attachmentCount,
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
        { title: t.start, href: "/" },
        { title: t.notebooks, href: "/app/notebooks" },
        { title: notebook.name, href: `/app/notebooks/${notebook.shortId}` },
        { title: `#${tagParam}` },
      ]}
    >
      <AppWorkspace class="flex-1 min-h-0">
        <WorkspaceEventBridge notebookId={notebook.shortId} appUrl={appUrl} initialCursor={workspaceCursor} />
        <NotebookSidebar ctx={ctx} />
        <AppWorkspace.Content>
          <AppWorkspace.Main class="flex-col p-[var(--ui-space-shell)]" scroll={false}>
            {/* SearchBar (full width) + note counter on the right. The
                tag itself already lives in the breadcrumb above. */}
            <div class="flex items-center gap-2">
              <div class="flex-1 min-w-0">
                <SearchBar
                  value={search}
                  action={baseHref}
                  placeholder={t.searchTaggedNotes({ tag: tagParam })}
                  ariaLabel={t.searchTaggedNotesLabel({ tag: tagParam })}
                />
              </div>
              <span class="shrink-0 text-xs text-dimmed tabular-nums">
                {search
                  ? t.filteredCount({ shown: paginatedResult.total, total: totalNotesForTag })
                  : t.noteCount({ count: totalNotesForTag })}
              </span>
            </div>

            <div class="mt-2 flex-1 min-h-0 overflow-y-auto flex flex-col gap-2">
              {paginatedResult.items.length > 0 ? (
                <ul class="flex flex-col gap-1">
                  {paginatedResult.items.map((n) => (
                    <li>
                      <a
                        href={buildNoteUrl(notebook.shortId, n.shortId)}
                        class="flex flex-col items-stretch gap-1 rounded-[var(--ui-radius-control)] px-3 py-2.5 no-underline transition-colors hover:bg-[var(--ui-hover)]"
                      >
                        <div class="flex items-center gap-2">
                          <i class="ti ti-file-text text-sm shrink-0 text-dimmed" />
                          <span class="flex-1 truncate text-xs text-primary">{n.title}</span>
                          <span class="shrink-0 text-[10px] text-dimmed tabular-nums">{formatDate(n.updatedAt)}</span>
                        </div>
                        {n.preview && <p class="text-[11px] text-dimmed line-clamp-2 pl-5">{n.preview}</p>}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <Placeholder
                  surface="paper"
                  icon="ti ti-search-off"
                  description={
                    <>
                      {search ? (
                        <p>
                          {t.noTaggedSearchResults({ tag: tagParam, query: search })}
                        </p>
                      ) : totalNotesForTag === 0 ? (
                        <>
                          <p>{t.noTaggedNotes({ tag: tagParam })}</p>
                          <p>{t.tagIndexMayBeStale}</p>
                        </>
                      ) : (
                        <p>{t.noResults}</p>
                      )}
                    </>
                  }
                />
              )}

              <Pagination currentPage={page} totalPages={totalPages} baseUrl={paginationBaseUrl} />
            </div>
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </Layout>
  );
});
