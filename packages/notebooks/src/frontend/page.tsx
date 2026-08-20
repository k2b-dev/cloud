import type { AuthContext } from "@valentinkolb/cloud/server";
import { expectUserBackedActor, getDateConfig } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import { notebooksService } from "@/service";
import { ssr } from "../config";
import { parseLastNotebookId, parsePinnedNotebookIds } from "./[id]/_components/settings/NotebookSettingsStore";
import { projectNotebook } from "./[id]/page-data";
import NotebooksOverview from "./NotebooksOverview.island";

/**
 * Notebooks list page - shows all notebooks the user has access to
 */
export default ssr<AuthContext>(async (c) => {
  const user = expectUserBackedActor(c);
  const url = new URL(c.req.raw.url);
  const cookieHeader = c.req.raw.headers.get("Cookie") ?? undefined;

  const [notebookPage, recentNotes, activityResult] = await Promise.all([
    notebooksService.notebook.list({ userId: user.id }),
    notebooksService.note.recentForUser({ userId: user.id, limit: 12 }),
    notebooksService.activity
      .list({ userId: user.id, limit: 30 })
      .then((page) => ({ page, error: null }))
      .catch((error: unknown) => ({
        page: { items: [], nextCursor: null },
        error: error instanceof Error ? error.message : "Failed to load notebook activity",
      })),
  ]);
  const notebooks = notebookPage.items;

  // Redirect to last opened notebook if ?recent=true
  if (url.searchParams.get("recent") === "true" && notebooks.length > 0) {
    const lastId = parseLastNotebookId(cookieHeader);
    if (lastId && notebooks.some((n) => n.shortId === lastId)) {
      return c.redirect(`/app/notebooks/${lastId}`);
    }
  }
  const templates = notebooksService.template.list();

  return () => (
    <Layout c={c} title={[{ title: "Start", href: "/" }, { title: "Notebooks" }]}>
      <NotebooksOverview
        notebooks={notebooks.map(projectNotebook)}
        templates={templates}
        recentNotes={recentNotes.map((note) => ({
          id: note.shortId,
          notebookId: note.notebookShortId,
          notebookName: note.notebookName,
          notebookIcon: note.notebookIcon,
          title: note.title,
          updatedAt: note.updatedAt,
        }))}
        initialActivity={{
          items: activityResult.page.items.map((item) => ({
            ...item,
            notebook: { id: item.notebook.shortId, name: item.notebook.name, icon: item.notebook.icon },
            note: item.note ? { id: item.note.shortId, title: item.note.title } : null,
          })),
          nextCursor: activityResult.page.nextCursor,
        }}
        initialActivityError={activityResult.error}
        initialPinnedNotebookIds={parsePinnedNotebookIds(cookieHeader)}
        dateConfig={getDateConfig(c)}
      />
    </Layout>
  );
});
