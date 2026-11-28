import { sql } from "@k2b/cloud";
import { toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import type { DateContext } from "@k2b/stdlib";
import { parsePinnedSpaceIds, parseRecentSpaceIds } from "../frontend/[id]/_components/settings/SpaceSettingsStore";
import { SIDEBAR_SPACES, type SpacesSidebarData } from "../frontend/[id]/_components/sidebar/spaces-navigation";
import type { OverviewView, OverviewWork, SpacePulse } from "../overview-contracts";
import { buildSpacePrincipalCondition } from "./access";
import { spacesService } from "./index";
import { dashboardSnapshot, listMyTasks } from "./items";

/**
 * Both SSR and view navigation use the same permission-filtered reads and limits. `day` also reads what counts today
 * (the agenda, the next entry, the overdue count) for the web overview's first row; the PWA does not ask for it.
 */
export async function loadOverviewWork(params: {
  userId: string;
  view: OverviewView;
  dateConfig: DateContext;
  day?: { now: Date };
}): Promise<OverviewWork> {
  // The agenda is the Today view's statement; the day adds it to the other views and asks for the next entry.
  const dashboardView = params.day ? (params.view === "upcoming" ? undefined : "today") : params.view === "mine" ? "counts" : params.view;
  const [dashboard, mine, writable] = await Promise.all([
    dashboardSnapshot({ ...params, view: dashboardView, todoLimit: 30, nextAfter: params.day?.now }),
    params.view === "mine" ? listMyTasks({ userId: params.userId, limit: 100, dateConfig: params.dateConfig }) : Promise.resolve([]),
    // The same permission check as a change through the API, read once for every row.
    spacesService.space
      .list({ subject: { type: "user", userId: params.userId }, requiredLevel: "write" })
      .then((page) => new Set(page.items.map((space) => space.id))),
  ]);
  const items = params.view === "mine" ? mine : params.view === "today" ? dashboard.events : dashboard.todos;
  const row = (item: (typeof items)[number] | (typeof dashboard.events)[number]) => ({
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
    canWrite: writable.has(item.spaceId),
  });
  return {
    view: params.view,
    counts: { mine: dashboard.assignedToMeCount, today: dashboard.todayCount, upcoming: dashboard.upcomingCount },
    items: items.map(row),
    ...(params.day
      ? {
          day: {
            at: params.day.now.toISOString(),
            agenda: dashboard.events.map(row),
            next: dashboard.next ? row(dashboard.next) : null,
            overdue: dashboard.assignedOverdueCount,
            done: dashboard.myDoneByDay,
          },
        }
      : {}),
  };
}

/**
 * The pulse of one Space for its reader: the overview's aggregate statement limited to the Space, so it keeps the
 * same access condition (a Space the reader cannot reach counts nothing) and costs one bounded read.
 */
export async function loadSpacePulse(params: { userId: string; spaceId: string; dateConfig?: DateContext }): Promise<SpacePulse> {
  const snapshot = await dashboardSnapshot({ ...params, view: "counts", todoLimit: 0 });
  return { done: snapshot.doneByDay, overdue: snapshot.overdueCount, unassigned: snapshot.unassignedCount };
}

/** The counts of the overview's views alone, for a line about the reader's work, such as the Cloud app's Start. */
export async function loadOverviewCounts(params: { userId: string; dateConfig: DateContext }): Promise<OverviewWork["counts"]> {
  const dashboard = await dashboardSnapshot({ ...params, view: "counts", todoLimit: 0 });
  return { mine: dashboard.assignedToMeCount, today: dashboard.todayCount, upcoming: dashboard.upcomingCount };
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

type DbSidebarSpace = { short_id: string; name: string; color: string; open_item_count: number; reachable_count: number };

/**
 * The Spaces of the sidebar in one statement, with the access condition of `spacesService.space.list` for a person
 * (a grant of theirs, of their groups or of every signed-in person, never `none`) and its order by name: the first
 * `limit` of them (`null` reads all), and the `named` ones (pinned, recent, open) wherever they stand, each with its
 * open tasks, and the count of every reachable Space for "+n more".
 */
async function readSidebarSpaces(params: { userId: string; named: string[]; limit: number | null }) {
  const principalMatch = buildSpacePrincipalCondition({ type: "user", userId: params.userId });
  const rows = await sql<DbSidebarSpace[]>`
    WITH reachable AS MATERIALIZED (
      SELECT DISTINCT s.id, s.short_id, s.name, s.color
      FROM spaces.spaces s
      JOIN spaces.space_access sa ON sa.space_id = s.id
      JOIN auth.access a ON a.id = sa.access_id
      WHERE a.permission <> 'none'::auth.permission_level
        AND ${principalMatch}
    ),
    listed AS (
      (SELECT * FROM reachable ORDER BY name, id LIMIT ${params.limit})
      UNION
      SELECT * FROM reachable WHERE short_id = ANY(${toPgTextArray(params.named)}::text[])
    )
    SELECT
      l.short_id,
      l.name,
      l.color,
      (
        SELECT COUNT(*)::int FROM spaces.items i
        JOIN spaces.columns c ON c.id = i.column_id
        WHERE i.space_id = l.id AND i.completed_at IS NULL AND c.is_done = false
      ) AS open_item_count,
      (SELECT COUNT(*)::int FROM reachable) AS reachable_count
    FROM listed l
    ORDER BY l.name, l.id
  `;
  return {
    spaces: rows.map((row) => ({ id: row.short_id, name: row.name, color: row.color, openItemCount: row.open_item_count })),
    unlisted: Math.max(0, (rows[0]?.reachable_count ?? 0) - rows.length),
  };
}

/**
 * Authorized sidebar snapshot, shared by the overview and each Space: what the sidebar and the phone menu show before a
 * search (the pinned, the recent and the open Space, and the first 20 by name) and how many reachable Spaces it left
 * out. The PWA's switcher has no "+n more" and passes `complete` for every Space.
 */
export async function loadSpacesSidebar(params: {
  userId: string;
  cookieHeader?: string;
  dateConfig?: DateContext;
  myWorkCount?: number | Promise<number>;
  /** The short ID of the open Space, listed wherever it stands. */
  openSpaceId?: string;
  complete?: boolean;
}): Promise<SpacesSidebarData> {
  const pinnedSpaceIds = parsePinnedSpaceIds(params.cookieHeader);
  const recentSpaceIds = parseRecentSpaceIds(params.cookieHeader);
  const named = [...pinnedSpaceIds, ...recentSpaceIds, ...(params.openSpaceId ? [params.openSpaceId] : [])];
  const [listed, myWorkCount] = await Promise.all([
    readSidebarSpaces({ userId: params.userId, named, limit: params.complete ? null : SIDEBAR_SPACES }),
    params.myWorkCount ??
      dashboardSnapshot({ userId: params.userId, dateConfig: params.dateConfig, view: "counts", todoLimit: 0 }).then(
        (snapshot) => snapshot.assignedToMeCount,
      ),
  ]);
  return { spaces: listed.spaces, unlistedSpaceCount: listed.unlisted, pinnedSpaceIds, recentSpaceIds, myWorkCount };
}
