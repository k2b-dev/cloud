import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getDateConfig, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { notebooksService } from "@/service";
import { ssr } from "../config";
import NotebooksHome from "./_components/overview/NotebooksHome.island";
import { parseLastNotebookId, parsePinnedNotebookIds } from "./[id]/_components/settings/NotebookSettingsStore";
import { projectNotebook } from "./[id]/page-data";
import { notebooksPageMessages } from "./messages";

/**
 * The home of Notebooks on v2: the notebooks this person reaches, the notes they edited last and the activity across
 * them, all read here so the first picture has no loader. `?recent=true` opens the notebook used last instead.
 */
export default ssr<AuthContext>(async (c) => {
  const user = expectUserBackedActor(c);
  const { t } = notebooksPageMessages.resolve([getLocale(c)]);
  const url = new URL(c.req.raw.url);
  const cookieHeader = c.req.raw.headers.get("Cookie") ?? undefined;

  const [notebookPage, recentNotes, activityResult] = await Promise.all([
    notebooksService.notebook.list({ userId: user.id }),
    notebooksService.note.recentForUser({ userId: user.id, limit: 12 }),
    notebooksService.activity
      .list({ userId: user.id, limit: 30 })
      .then((page) => ({ page, failed: false }))
      .catch(() => ({ page: { items: [], nextCursor: null }, failed: true })),
  ]);
  const notebooks = notebookPage.items;

  // Redirect to last opened notebook if ?recent=true
  if (url.searchParams.get("recent") === "true" && notebooks.length > 0) {
    const lastId = parseLastNotebookId(cookieHeader);
    if (lastId && notebooks.some((n) => n.shortId === lastId)) {
      return c.redirect(`/app/notebooks/${lastId}`);
    }
  }
  const templates = notebooksService.template.list(getLocale(c));
  const overviewStats = new Map(
    (await notebooksService.notebook.overviewStats({ notebookIds: notebooks.map((notebook) => notebook.id) })).map((stats) => [
      stats.notebookId,
      stats,
    ]),
  );

  return () => (
    <Layout printHint={t.printHint} c={c} fullPage fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.notebooks }]}>
      <NotebooksHome
        notebooks={notebooks.map((notebook) => {
          const { id, name, description, icon } = projectNotebook(notebook);
          const stats = overviewStats.get(notebook.id);
          return {
            id,
            name,
            description,
            icon,
            noteCount: stats?.noteCount ?? 0,
            lastEditedAt: stats?.lastNoteAt ?? null,
          };
        })}
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
        initialActivityFailed={activityResult.failed}
        initialPinnedNotebookIds={parsePinnedNotebookIds(cookieHeader)}
        dateConfig={getDateConfig(c)}
        now={new Date().toISOString()}
      />
    </Layout>
  );
});
