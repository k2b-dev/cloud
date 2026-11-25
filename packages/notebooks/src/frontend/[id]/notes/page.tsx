/**
 * The notebook's notes as one filtered list — `/app/notebooks/<id>/notes`. It replaces the tag page: a tag is one
 * filter of this list. The declaration in `query.ts` reads the address; the service filters with the person's access.
 */
import { hasRole } from "@k2b/cloud/contracts";
import { type AuthContext, expectUserBackedActor, getDateConfig, getLocale } from "@k2b/cloud/server";
import { get } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { notebooksService } from "@/service";
import { ssr } from "../../../config";
import { requestedPresentationMode } from "../../../lib/presentation-url";
import { parseSidebarFilter } from "../../../lib/sidebar-filter";
import { notebooksPageMessages } from "../../messages";
import RememberNotebook from "../_components/RememberNotebook.island";
import { parseFullWidth, parseNavigationHidden, parseSettings } from "../_components/settings/NotebookSettingsStore";
import type { NotebookContext } from "../_components/sidebar/types";
import WorkspaceEventBridge from "../_components/sidebar/WorkspaceEventBridge.island";
import { notebookWorkspaceMessages } from "../messages";
import { loadSidebarWithoutNote, projectNotebook } from "../page-data";
import { notesListMessages } from "./messages";
import NotesListScreen from "./NotesListScreen.island";
import { NOTES_PER_PAGE, notesHref, notesQuery, parseNotesAddress } from "./query";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const t = notebookWorkspaceMessages.resolve([locale]).t;
  const words = notesListMessages.resolve([locale]).t;
  const page = notebooksPageMessages.resolve([locale]).t;
  const user = expectUserBackedActor(c);
  const url = new URL(c.req.url);

  const found = await notebooksService.notebook.getByShortId({ shortId: c.req.param("id")! });
  if (!found) return ssr.error(c, 404, { action: { label: page.notebooks, href: "/app/notebooks" } });
  const permission = hasRole(user, "admin")
    ? "admin"
    : await notebooksService.notebook.permission.get({ notebookId: found.id, userId: user.id });
  if (permission === "none")
    return ssr.error(c, 403, { description: t.accessDeniedDescription, action: { label: page.notebooks, href: "/app/notebooks" } });

  const cookieHeader = c.req.header("Cookie");
  const settings = parseSettings(cookieHeader, found.shortId);
  const [notebook, tags, workspaceCursor, attachmentCount, favoriteRows, appUrl] = await Promise.all([
    notebooksService.notebook.get({ id: found.id }),
    notebooksService.tag.listForNotebook({ notebookId: found.id }),
    notebooksService.workspaceEvents.latestCursor({ notebookId: found.id }),
    notebooksService.attachment.count({ notebookId: found.id }),
    notebooksService.note.favorites.listIds({ notebookId: found.id, userId: user.id }),
    get<string>("app.url"),
  ]);
  if (!notebook) return ssr.error(c, 404, { action: { label: page.notebooks, href: "/app/notebooks" } });

  const query = notesQuery(locale, tags);
  const address = parseNotesAddress(query, url.searchParams);
  const mode = requestedPresentationMode(url.searchParams);
  const sidebarFilter = parseSidebarFilter(url.searchParams);
  const [list, sidebar] = await Promise.all([
    notebooksService.pages.list({
      notebookId: notebook.id,
      userId: user.id,
      favorite: address.state.filters.favorite,
      tag: address.state.filters.tag ?? null,
      search: address.state.search ?? null,
      sort: address.state.sort.field,
      offset: (address.page - 1) * NOTES_PER_PAGE,
      limit: NOTES_PER_PAGE,
    }),
    loadSidebarWithoutNote({ notebook, userId: user.id, sort: settings.treeSort, locale, filter: sidebarFilter, permission }),
  ]);
  const pages = Math.max(1, Math.ceil(list.total / NOTES_PER_PAGE));
  // A deletion or an old link can leave the requested page past the end; open the last page instead.
  if (address.page > pages) return c.redirect(notesHref(notebook.shortId, query, address.state, pages, mode));

  const ctx: NotebookContext = {
    notebook: projectNotebook(notebook),
    ...sidebar,
    selectedNoteId: null,
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
    sidebarFilter,
    presentationMode: mode,
  };
  const ignored =
    address.issues.length > 0
      ? address.issues.map((issue) => (issue.param ? `${issue.param}=${issue.value}` : issue.code)).join(", ")
      : null;
  const tag = address.state.filters.tag;
  c.get("page").title = tag ? `#${tag} · ${notebook.name}` : `${words.notes} · ${notebook.name}`;

  return () => (
    <Layout
      c={c}
      fullPage
      fullWidth
      ui="v2"
      context={{ scope: { type: "notebooks.notebook", id: notebook.shortId } }}
      printHint={page.printHint}
      title={[
        { title: page.start, href: "/" },
        { title: page.notebooks, href: "/app/notebooks" },
        { title: notebook.name, href: `/app/notebooks/${notebook.shortId}` },
        { title: tag ? `#${tag}` : words.notes },
      ]}
    >
      <RememberNotebook notebookId={notebook.shortId} />
      <WorkspaceEventBridge notebookId={notebook.shortId} appUrl={appUrl} initialCursor={workspaceCursor} />
      <NotesListScreen
        ctx={ctx}
        state={address.state}
        page={address.page}
        pages={pages}
        total={list.total}
        items={list.items}
        ignored={ignored}
        mode={mode}
        graphBack={c.req.path + url.search}
        now={new Date().toISOString()}
      />
    </Layout>
  );
});
