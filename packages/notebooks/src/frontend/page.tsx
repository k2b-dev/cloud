import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { notebooksService } from "@/service";
import { ssr } from "../config";
import NotebooksStart from "./_components/overview/NotebooksStart.island";
import { parseLastNotebookId } from "./[id]/_components/settings/NotebookSettingsStore";
import { notebooksPageMessages } from "./messages";

/** The notebook used last while this person still reaches it through a grant: that one notebook and its access. */
const lastReached = async (userId: string, shortId: string | null) => {
  const notebook = shortId ? await notebooksService.notebook.getByShortId({ shortId }) : null;
  if (!notebook) return null;
  return (await notebooksService.notebook.permission.get({ notebookId: notebook.id, userId })) === "none" ? null : notebook.shortId;
};

/** The first notebook this person reaches, by name: one row, not every notebook. */
const firstReached = async (userId: string) =>
  (await notebooksService.notebook.list({ userId, pagination: { page: 1, perPage: 1 } })).items[0]?.shortId ?? null;

/** The templates a first start offers as cards, in this order: a diary, recipes, a reading list. */
const START_ORDER = ["daily-notes", "recipe-collector", "reading-list"];
const rank = (id: string) => (START_ORDER.includes(id) ? START_ORDER.indexOf(id) : START_ORDER.length);

/**
 * Notebooks opens a notebook: the one this person used last while they still reach it, else the first they reach.
 * There is no overview page (the maintainer: it added nothing). Only a person without any notebook sees a page here,
 * which starts the first one.
 */
export default ssr<AuthContext>(async (c) => {
  const user = expectUserBackedActor(c);
  const { t } = notebooksPageMessages.resolve([getLocale(c)]);
  const target =
    (await lastReached(user.id, parseLastNotebookId(c.req.raw.headers.get("Cookie") ?? undefined))) ?? (await firstReached(user.id));
  if (target) {
    // A command link ("New note" from another app) lands here; the notebook page takes it over. `recent` is the
    // rail's former link, still in bookmarks, and means what this redirect does anyway.
    const query = new URL(c.req.url).searchParams;
    query.delete("recent");
    return c.redirect(`/app/notebooks/${target}${query.size > 0 ? `?${query}` : ""}`);
  }
  // the ways to start with the pages each makes, the three most useful first (they stand as cards; the rest stay in
  // the dialog's choice); the open dialog comes from the address, so a reload shows the same
  const locale = getLocale(c);
  const templates = notebooksService.template
    .list(locale)
    .map((template) => ({ ...template, pages: notebooksService.template.outline(template.id, locale) ?? [] }))
    .sort((a, b) => rank(a.id) - rank(b.id));
  const blankPages = notebooksService.template.welcomeOutline();
  const open = c.req.query("new") ?? null;
  return () => (
    <Layout printHint={t.printHint} c={c} fullPage fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.notebooks }]}>
      <NotebooksStart templates={templates} blankPages={blankPages} open={open} />
    </Layout>
  );
});
