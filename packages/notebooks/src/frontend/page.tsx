import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { notebooksService } from "@/service";
import { ssr } from "../config";
import NotebooksStart from "./_components/overview/NotebooksStart.island";
import { notebooksPageMessages } from "./messages";
import { startTarget } from "./start-target";

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
  const target = await startTarget(user.id, c.req.raw.headers.get("Cookie") ?? undefined);
  if (target) {
    // A command link ("New note" from another app) lands here; the notebook page takes it over. `recent` is the
    // rail's former link, still in bookmarks, and means what this redirect does anyway.
    const query = new URL(c.req.url).searchParams;
    query.delete("recent");
    return c.redirect(`/app/notebooks/${target}${query.size > 0 ? `?${query}` : ""}`);
  }
  // the ways to start with how many pages each makes and its preview, the three most useful first (they stand as cards; the rest stay in
  // the dialog's choice); the open dialog comes from the address, so a reload shows the same
  const locale = getLocale(c);
  const templates = notebooksService.template
    .list(locale)
    .map((template) => ({
      ...template,
      pageCount: notebooksService.template.outline(template.id, locale)?.length ?? 0,
      preview: notebooksService.template.preview(template.id, locale) ?? undefined,
    }))
    .sort((a, b) => rank(a.id) - rank(b.id));
  const blankPageCount = notebooksService.template.welcomeOutline(locale).length;
  const blankPreview = notebooksService.template.welcomePreview(locale);
  const open = c.req.query("new") ?? null;
  return () => (
    <Layout printHint={t.printHint} c={c} fullPage fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.notebooks }]}>
      <NotebooksStart templates={templates} blankPageCount={blankPageCount} blankPreview={blankPreview} open={open} />
    </Layout>
  );
});
