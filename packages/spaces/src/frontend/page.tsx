import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getDateConfig, getLocale } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { spacesService } from "@/service";
import { loadOverviewWork, loadSpacesSidebar } from "@/service/overview";
import { ssr } from "../config";
import { spacesPageHelp } from "../help";
import { parseLastSpaceId } from "./[id]/_components/settings/SpaceSettingsStore";
import { overviewMessages } from "./overview-messages";
import SpacesOverview from "./SpacesOverview.island";
import { firstOpenSpacesHint } from "./spaces-hints";

const log = logger("spaces:overview");

/**
 * Spaces list page - shows all spaces the user has access to
 */
export default ssr<AuthContext>(async (c) => {
  const { t } = overviewMessages.resolve([getLocale(c)]);
  const user = expectUserBackedActor(c);
  const url = new URL(c.req.raw.url);
  const initialView = url.searchParams.get("view");
  const view = initialView === "today" || initialView === "upcoming" ? initialView : "mine";
  const cookieHeader = c.req.raw.headers.get("Cookie") ?? undefined;

  const subject = { type: "user" as const, userId: user.id };
  const work = loadOverviewWork({ userId: user.id, view, dateConfig: getDateConfig(c) });
  const [sidebar, initialWork, activityResult] = await Promise.all([
    loadSpacesSidebar({ userId: user.id, cookieHeader, dateConfig: getDateConfig(c), myWorkCount: work.then((work) => work.counts.mine) }),
    work,
    spacesService.activity
      .list({ subject, limit: 30 })
      .then((page) => ({ page, error: null }))
      .catch((error: unknown) => {
        log.warn("Failed to load Spaces activity", { error: error instanceof Error ? error.message : "Unknown error" });
        return { page: { items: [], nextCursor: null }, error: t.activityLoadFailed };
      }),
  ]);
  // Redirect to last opened space if ?recent=true
  if (url.searchParams.get("recent") === "true" && sidebar.spaces.length > 0) {
    const lastId = parseLastSpaceId(cookieHeader);
    if (lastId && sidebar.spaces.some((s) => s.id === lastId)) {
      return c.redirect(`/app/spaces/${lastId}`);
    }
  }

  return () => (
    <Layout c={c} help={spacesPageHelp.overview} title={[{ title: t.start, href: "/" }, { title: "Spaces" }]}>
      <SpacesOverview
        spaces={sidebar.spaces}
        sidebarHint={firstOpenSpacesHint(c, [{ id: "spaces.overview-sidebar", allowed: true }]) === "spaces.overview-sidebar"}
        initialView={view}
        initialPinnedSpaceIds={sidebar.pinnedSpaceIds}
        initialWork={initialWork}
        initialActivity={{
          items: activityResult.page.items.map((item) => ({
            ...item,
            space: { id: item.space.shortId, name: item.space.name, color: item.space.color },
            item: item.item ? { id: item.item.shortId, title: item.item.title } : null,
          })),
          nextCursor: activityResult.page.nextCursor,
        }}
        initialActivityError={activityResult.error}
        dateConfig={getDateConfig(c)}
      />
    </Layout>
  );
});
