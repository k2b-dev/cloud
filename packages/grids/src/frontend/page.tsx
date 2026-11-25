import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { currentActorUser, gridsAccessContext, listUsableCustomAppsForAccess } from "../api/permissions";
import { toPublicBases } from "../api/public-dto";
import { ssr } from "../config";
import { gridsService } from "../service";
import BasesOverview from "./_components/overview/BasesOverview.island";
import { APPS_PER_PAGE, BASES_PER_PAGE, basesHref, basesQuery, parseBasesAddress } from "./_components/overview/bases-query";
import { resolveGridsMessages } from "./messages";
import { recentBasePath } from "./recent-base-path";

/** One overview screen of recently changed tables. */
const RECENT_TABLE_LIMIT = 12;
/** The apps the side column shows before "All apps". */
const APP_TILE_LIMIT = 8;

/**
 * Bases overview on v2: the visible bases, searched and paged in the address (`bases-query.ts`); beside them the
 * usable apps and the most recently changed tables across bases, which search and paging leave alone.
 */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = resolveGridsMessages(locale);
  const user = currentActorUser(c);
  if (!user) return ssr.error(c, 403, { description: t.signInToOpenGrids });
  const url = new URL(c.req.url);
  const query = basesQuery(locale);
  const address = parseBasesAddress(query, url.searchParams);
  const search = address.state.search ?? "";
  const limit = BASES_PER_PAGE;
  const offset = (address.page - 1) * limit;

  const visible = await gridsService.base.listVisible({
    userId: user.id,
    userGroups: user.memberofGroupIds,
    query: search,
    limit,
    offset,
  });

  if (url.searchParams.get("recent") === "true" && visible.items.length > 0) {
    const lastPath = recentBasePath(c.req.header("Cookie"), visible.items);
    if (lastPath) return c.redirect(lastPath, 302);
  }
  // A page past the end, after deletions or from an old link, opens the last page with the same search.
  const pages = Math.max(1, Math.ceil(visible.total / limit));
  if (address.page > pages) return c.redirect(basesHref(query, address.state, pages), 302);

  // `?apps=<page>` swaps the overview for the full list of usable apps.
  const appsPage = address.apps;
  const appsLimit = appsPage ? APPS_PER_PAGE : APP_TILE_LIMIT;
  const usableApps = await listUsableCustomAppsForAccess(gridsAccessContext(c), {
    limit: appsLimit,
    offset: appsPage ? (appsPage - 1) * APPS_PER_PAGE : 0,
  });
  const apps = {
    items: usableApps.items
      .filter((app) => app.publishedValid)
      .map((app) => ({ id: app.shortId, name: app.name, icon: app.icon, baseName: app.baseName })),
    total: usableApps.total,
    page: appsPage,
  };

  const templates = gridsService.template.list(locale);
  const publicBases = await toPublicBases(visible.items);
  // Recent tables always span the first page of all visible bases, independent of search and paging.
  const scope =
    address.page === 1 && !search
      ? visible.items
      : (await gridsService.base.listVisible({ userId: user.id, userGroups: user.memberofGroupIds, limit })).items;
  const basesById = new Map([...scope, ...visible.items].map((base) => [base.id, base]));
  const activity = await gridsService.base.overviewActivity({ baseIds: [...basesById.keys()], tableLimit: RECENT_TABLE_LIMIT });
  const baseStats = Object.fromEntries(
    activity.bases.flatMap((stats) => {
      const base = basesById.get(stats.baseId);
      return base ? [[base.shortId, { tableCount: stats.tableCount, lastActivityAt: stats.lastActivityAt }]] : [];
    }),
  );
  const recentTables = activity.tables.flatMap((table) => {
    const base = basesById.get(table.baseId);
    return base
      ? [
          {
            id: table.shortId,
            baseId: base.shortId,
            baseName: base.name,
            name: table.name,
            icon: table.icon,
            lastActivityAt: table.lastActivityAt,
          },
        ]
      : [];
  });

  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: "Grids" }]}>
      <BasesOverview
        state={address.state}
        page={address.page}
        bases={publicBases}
        total={visible.total}
        templates={templates}
        baseStats={baseStats}
        recentTables={recentTables}
        apps={apps}
        create={address.create}
        dateConfig={getDateConfig(c)}
      />
    </Layout>
  );
});
