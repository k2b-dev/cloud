import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { currentActorUser } from "../api/permissions";
import { toPublicBases } from "../api/public-dto";
import { ssr } from "../config";
import { gridsService } from "../service";
import BasesOverview from "./_components/overview/BasesOverview.island";
import { resolveGridsMessages } from "./messages";
import { recentBasePath } from "./recent-base-path";

/**
 * Bases list page — shows every base the user has access to.
 * Layout matches the spaces / notebooks index pages: hero + notice card
 * with the create button + paper-card grid.
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

  return () => (
    <Layout c={c} title={[{ title: t.start, href: "/" }, { title: "Grids" }]}>
      <BasesOverview
        bases={publicBases}
        total={visible.total}
        limit={limit}
        offset={offset}
        templates={templates}
        initialQuery={initialQuery}
      />
    </Layout>
  );
});
