import { hasRole } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { notebooksService } from "@/service";
import { ssr } from "../config";
import { parseLastNotebookId } from "./[id]/_components/settings/NotebookSettingsStore";
import { notebooksPageMessages } from "./messages";
import NoNotebooks from "./NoNotebooks.island";

/**
 * `/app/notebooks` opens a notebook straight away: the one this person opened last, else the first one they can see.
 * The address's parameters go along (except the former `recent=true`). Only without any notebook it shows a workspace
 * that offers the first one. There is no overview page (maintainer decision on #4185).
 */
export default ssr<AuthContext>(async (c) => {
  const user = expectUserBackedActor(c);
  const params = new URL(c.req.url).searchParams;
  params.delete("recent");
  const open = (shortId: string) => c.redirect(`/app/notebooks/${shortId}${params.size ? `?${params}` : ""}`);

  const lastId = parseLastNotebookId(c.req.header("Cookie"));
  if (lastId) {
    const last = await notebooksService.notebook.getByShortId({ shortId: lastId });
    const allowed =
      last &&
      (hasRole(user, "admin") || (await notebooksService.notebook.permission.get({ notebookId: last.id, userId: user.id })) !== "none");
    if (last && allowed) return open(last.shortId);
  }
  const [first] = (await notebooksService.notebook.list({ userId: user.id, pagination: { page: 1, perPage: 1 } })).items;
  if (first) return open(first.shortId);

  const { t } = notebooksPageMessages.resolve([getLocale(c)]);
  const templates = notebooksService.template.list(getLocale(c));
  return () => (
    <Layout printHint={t.printHint} c={c} fullPage fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.notebooks }]}>
      <NoNotebooks templates={templates} />
    </Layout>
  );
});
