import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { currentActorUser } from "../api/permissions";
import { toPublicBases } from "../api/public-dto";
import { ssr } from "../config";
import { gridsService } from "../service";
import BasesOverview from "./_components/overview/BasesOverview.island";
import { resolveGridsMessages } from "./messages";
import { recentBasePath } from "./recent-base-path";

/** One overview screen of recently changed tables. */
const RECENT_TABLE_LIMIT = 12;

/**
 * Bases overview: visible bases as sidebar objects and the most recently
 * changed tables across them. Search and pagination only narrow the sidebar.
 */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = resolveGridsMessages(locale);
  const user = currentActorUser(c);
  if (!user) {
    return () => (
      <Layout c={c} title={[{ title: t.start, href: "/" }, { title: "Grids" }]}>
        <div class="paper mx-auto mt-16 max-w-md p-8 text-center text-dimmed">
          <i class="ti ti-lock text-sm" /> {t.signInToOpenGrids}
        </div>
      </Layout>
    );
  }
  const url = new URL(c.req.url);
  const initialQuery = url.searchParams.get("q")?.trim() ?? "";
  const pageRaw = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const limit = 100;
  const offset = (page - 1) * limit;

  const visible = await gridsService.base.listVisible({
    userId: user.id,
    userGroups: user.memberofGroupIds,
    query: initialQuery,
    limit,
    offset,
  });

  if (url.searchParams.get("recent") === "true" && visible.items.length > 0) {
    const lastPath = recentBasePath(c.req.header("Cookie"), visible.items);
    if (lastPath) return c.redirect(lastPath, 302);
  }

  const templates = gridsService.template.list(locale);
  const publicBases = await toPublicBases(visible.items);
  // Recent tables always span the first page of all visible bases, independent of search and paging.
  const scope =
    page === 1 && !initialQuery
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
    <Layout c={c} title={[{ title: t.start, href: "/" }, { title: "Grids" }]}>
      <BasesOverview
        bases={publicBases}
        total={visible.total}
        limit={limit}
        offset={offset}
        templates={templates}
        initialQuery={initialQuery}
        baseStats={baseStats}
        recentTables={recentTables}
        dateConfig={getDateConfig(c)}
      />
    </Layout>
  );
});
