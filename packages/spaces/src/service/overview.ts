import { toPgUuidArray } from "@k2b/cloud/services";
import type { DateContext } from "@k2b/stdlib";
import { sql } from "bun";
import type { OverviewView, OverviewWork } from "../overview-contracts";
import { dashboardSnapshot, listMyTasks } from "./items";

/** Both SSR and view navigation use the same permission-filtered reads and limits. */
export async function loadOverviewWork(params: { userId: string; view: OverviewView; dateConfig: DateContext }): Promise<OverviewWork> {
  const [dashboard, mine] = await Promise.all([
    dashboardSnapshot({ ...params, view: params.view === "mine" ? "counts" : params.view, todoLimit: 30 }),
    params.view === "mine" ? listMyTasks({ userId: params.userId, limit: 100 }) : Promise.resolve([]),
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
    })),
  };
}

export type SpaceOverviewStats = { spaceId: string; openItemCount: number; lastActivityAt: string };

/** Per-space sidebar facts for Spaces the caller already resolved through access checks; one query. */
export async function loadSpaceOverviewStats(params: { spaceIds: string[] }): Promise<SpaceOverviewStats[]> {
  if (params.spaceIds.length === 0) return [];
  const rows = await sql<{ id: string; open_item_count: number; last_activity_at: Date }[]>`
    SELECT
      s.id,
      (
        SELECT COUNT(*)::int FROM spaces.items i
        JOIN spaces.columns c ON c.id = i.column_id
        WHERE i.space_id = s.id AND i.completed_at IS NULL AND c.is_done = false
      ) AS open_item_count,
      COALESCE((SELECT MAX(e.last_occurred_at) FROM spaces.activity_events e WHERE e.space_id = s.id), s.updated_at) AS last_activity_at
    FROM spaces.spaces s
    WHERE s.id = ANY(${toPgUuidArray(params.spaceIds)}::uuid[])
  `;
  return rows.map((row) => ({ spaceId: row.id, openItemCount: row.open_item_count, lastActivityAt: row.last_activity_at.toISOString() }));
}
