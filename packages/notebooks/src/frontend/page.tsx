import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { notebooksService } from "@/service";
import { ssr } from "../config";
import NotebooksStart from "./_components/overview/NotebooksStart.island";
import { parseLastNotebookId } from "./[id]/_components/settings/NotebookSettingsStore";
import { notebooksPageMessages } from "./messages";

/**
 * Notebooks opens a notebook: the one this person used last while they still reach it, else the first they reach.
 * There is no overview page (the maintainer: it added nothing). Only a person without any notebook sees a page here,
 * which starts the first one.
 */
export default ssr<AuthContext>(async (c) => {
  const user = expectUserBackedActor(c);
  const { t } = notebooksPageMessages.resolve([getLocale(c)]);
  const notebooks = (await notebooksService.notebook.list({ userId: user.id })).items;
  const [first] = notebooks;
  if (first) {
    const lastId = parseLastNotebookId(c.req.raw.headers.get("Cookie") ?? undefined);
    const target = lastId && notebooks.some((notebook) => notebook.shortId === lastId) ? lastId : first.shortId;
    // A command link ("New note" from another app) lands here; the notebook page takes it over. `recent` is the
    // rail's former link, still in bookmarks, and means what this redirect does anyway.
    const query = new URL(c.req.url).searchParams;
    query.delete("recent");
    return c.redirect(`/app/notebooks/${target}${query.size > 0 ? `?${query}` : ""}`);
  }
  const templates = notebooksService.template.list(getLocale(c));
  return () => (
    <Layout printHint={t.printHint} c={c} fullPage fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.notebooks }]}>
      <NotebooksStart templates={templates} />
    </Layout>
  );
});
