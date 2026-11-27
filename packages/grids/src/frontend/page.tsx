import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { currentAccessSubject, currentActorUser } from "../api/permissions";
import { ssr } from "../config";
import { gridsService } from "../service";
import { hasAtLeast, loadBaseGrantsForSubject, resolveEffectivePermission } from "../service/permission-resolver";
import { withParam } from "./_components/overview/bases-query";
import { BLANK } from "./_components/overview/CreateBaseDialog";
import GridsStart, { type StartWay } from "./_components/overview/GridsStart.island";
import { overviewMessages } from "./_components/overview/messages";
import { parseLastGridsPath } from "./_components/sidebar/GridsSettingsStore";
import { resolveGridsMessages } from "./messages";
import { recentBasePath } from "./recent-base-path";

/**
 * The templates the start offers beside a blank base: the broadest uses (money, things and their loans, invoices).
 * The others stay in the dialog's choice and in the switcher's "Aus Vorlage".
 */
export const START_TEMPLATES = ["finance", "inventory", "billing"] as const;

/**
 * Grids has no overview page: it opens the base someone worked in last (else the newest they can open), and every old
 * link to the overview lands there too. `?new=` opens the dialog that creates a base on that base's home. Only before
 * the first base does the page show something of its own: the four ways to begin (`GridsStart`).
 */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = resolveGridsMessages(locale);
  const user = currentActorUser(c);
  if (!user) return ssr.error(c, 403, { description: t.signInToOpenGrids });
  const create = new URL(c.req.url).searchParams.get("new")?.trim() || null;
  const subject = { userId: user.id, userGroups: user.memberofGroupIds };

  const cookie = c.req.header("Cookie");
  const home = (base: { shortId: string }) => `/app/grids/${base.shortId}`;
  const go = (base: { shortId: string }, page?: string | null) =>
    c.redirect(create ? withParam(home(base), "new", create) : (page ?? home(base)), 302);

  // the base of the last page, while the person may still open it: the base by its id and its grants (2 statements)
  const lastId = parseLastGridsPath(cookie)?.split(/[/?#]/)[3];
  const lastBase = lastId ? await gridsService.base.getByShortId(lastId) : null;
  if (lastBase) {
    const grants = await loadBaseGrantsForSubject({ baseId: lastBase.id, subject: currentAccessSubject(c) });
    if (hasAtLeast(resolveEffectivePermission(grants, { baseId: lastBase.id }), "read"))
      return go(lastBase, recentBasePath(cookie, [lastBase]));
  }
  // else the newest base the person may open (1 statement, from their own grants)
  const [newest] = await gridsService.base.listVisibleItems({ ...subject, limit: 1 });
  if (newest) return go(newest);

  const templates = gridsService.template.list(locale);
  const words = overviewMessages.resolve([locale]).t;
  const ways: StartWay[] = [
    { id: BLANK, name: words.blankBase, icon: "plus", preview: null },
    ...START_TEMPLATES.flatMap((id) => {
      const template = templates.find((each) => each.id === id);
      return template
        ? [{ id, name: template.name, icon: template.icon.replace(/^ti ti-/, ""), preview: gridsService.template.preview(id, locale) }]
        : [];
    }),
  ];
  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: "Grids" }]}>
      <GridsStart ways={ways} templates={templates} create={create} />
    </Layout>
  );
});
