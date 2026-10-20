import { toPgUuidArray } from "@k2b/cloud/services";
import type { DateContext } from "@k2b/stdlib";
import { sql } from "bun";
import { parsePinnedSpaceIds } from "../frontend/[id]/_components/settings/SpaceSettingsStore";
import type { SpacesSidebarData } from "../frontend/[id]/_components/sidebar/spaces-navigation";
import type { OverviewView, OverviewWork } from "../overview-contracts";
import { spacesService } from "./index";
import { dashboardSnapshot, listMyTasks } from "./items";
import { spacesPublicResources } from "./public-resources";

/** Both SSR and view navigation use the same permission-filtered reads and limits. */
export async function loadOverviewWork(params: { userId: string; view: OverviewView; dateConfig: DateContext }): Promise<OverviewWork> {
  const [dashboard, mine] = await Promise.all([
    dashboardSnapshot({ ...params, view: params.view === "mine" ? "counts" : params.view, todoLimit: 30 }),
    params.view === "mine" ? listMyTasks({ userId: params.userId, limit: 100, dateConfig: params.dateConfig }) : Promise.resolve([]),
  ]);
  const items = params.view === "mine" ? mine : params.view === "today" ? dashboard.events : dashboard.todos;
  return {
    view: params.view,
    counts: { mine: dashboard.assignedToMeCount, today: dashboard.todayCount, upcoming: dashboard.upcomingCount },
    items: items.map((item) => ({
      shortId: item.shortId,
      spaceShortId: item.spaceShortId,
      spaceName: item.spaceName,
      spaceColor: item.spaceColor,
      title: item.title,
      priority: item.priority,
      startsAt: "startsAt" in item ? item.startsAt : null,
      endsAt: "endsAt" in item ? item.endsAt : null,
      deadline: item.deadline,
      deadlineAllDay: item.deadlineAllDay,
    })),
  };
}

export type SpaceOverviewStats = { spaceId: string; openItemCount: number };

/** Per-space sidebar facts for Spaces the caller already resolved through access checks; one query. */
export async function loadSpaceOverviewStats(params: { spaceIds: string[] }): Promise<SpaceOverviewStats[]> {
  if (params.spaceIds.length === 0) return [];
  const rows = await sql<{ id: string; open_item_count: number }[]>`
    SELECT
      s.id,
      (
        SELECT COUNT(*)::int FROM spaces.items i
        JOIN spaces.columns c ON c.id = i.column_id
        WHERE i.space_id = s.id AND i.completed_at IS NULL AND c.is_done = false
      ) AS open_item_count
    FROM spaces.spaces s
    WHERE s.id = ANY(${toPgUuidArray(params.spaceIds)}::uuid[])
  `;
  return rows.map((row) => ({ spaceId: row.id, openItemCount: row.open_item_count }));
}

/** Authorized sidebar snapshot, shared by the overview and each Space. */
export async function loadSpacesSidebar(params: {
  userId: string;
  cookieHeader?: string;
  dateConfig?: DateContext;
  myWorkCount?: number | Promise<number>;
}): Promise<SpacesSidebarData> {
  const [page, myWorkCount] = await Promise.all([
    spacesService.space.list({ subject: { type: "user", userId: params.userId } }),
    params.myWorkCount ??
      dashboardSnapshot({ userId: params.userId, dateConfig: params.dateConfig, view: "counts", todoLimit: 0 }).then(
        (snapshot) => snapshot.assignedToMeCount,
      ),
  ]);
  const [projected, stats] = await Promise.all([
    spacesPublicResources.projectSpaces(page.items),
    loadSpaceOverviewStats({ spaceIds: page.items.map((space) => space.id) }),
  ]);
  const byId = new Map(stats.map((entry) => [entry.spaceId, entry.openItemCount]));
  return {
    spaces: projected.map((space, index) => ({
      id: space.id,
      name: space.name,
      color: space.color,
      description: space.description,
      openItemCount: byId.get(page.items[index]!.id) ?? 0,
    })),
    pinnedSpaceIds: parsePinnedSpaceIds(params.cookieHeader),
    myWorkCount,
  };
}
