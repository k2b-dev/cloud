import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getDateConfig, getLocale } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { spacesService } from "@/service";
import { loadOverviewWork, loadSpaceOverviewStats } from "@/service/overview";
import { spacesPublicResources } from "@/service/public-resources";
import { ssr } from "../config";
import { parseLastSpaceId, parsePinnedSpaceIds } from "./[id]/_components/settings/SpaceSettingsStore";
import SpacesOverview, { overviewMessages } from "./SpacesOverview.island";

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
  const [spacesPage, initialWork, activityResult] = await Promise.all([
    spacesService.space.list({ subject }),
    loadOverviewWork({ userId: user.id, view, dateConfig: getDateConfig(c) }),
    spacesService.activity
      .list({ subject, limit: 30 })
      .then((page) => ({ page, error: null }))
      .catch((error: unknown) => {
        log.warn("Failed to load Spaces activity", { error: error instanceof Error ? error.message : "Unknown error" });
        return { page: { items: [], nextCursor: null }, error: t.activityLoadFailed };
      }),
  ]);
  const [userSpaces, spaceStats] = await Promise.all([
    spacesPublicResources.projectSpaces(spacesPage.items),
    loadSpaceOverviewStats({ spaceIds: spacesPage.items.map((space) => space.id) }),
  ]);
  const statsBySpace = new Map(spaceStats.map((stats) => [stats.spaceId, stats]));

  // Redirect to last opened space if ?recent=true
  if (url.searchParams.get("recent") === "true" && userSpaces.length > 0) {
    const lastId = parseLastSpaceId(cookieHeader);
    if (lastId && userSpaces.some((s) => s.id === lastId)) {
      return c.redirect(`/app/spaces/${lastId}`);
    }
  }

  return () => (
    <Layout c={c} title={[{ title: t.start, href: "/" }, { title: "Spaces" }]}>
      <SpacesOverview
        spaces={userSpaces.map((space, index) => {
          const stats = statsBySpace.get(spacesPage.items[index]!.id);
          return { ...space, openItemCount: stats?.openItemCount ?? 0, lastActivityAt: stats?.lastActivityAt ?? space.updatedAt };
        })}
        initialView={view}
        initialPinnedSpaceIds={parsePinnedSpaceIds(cookieHeader)}
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
