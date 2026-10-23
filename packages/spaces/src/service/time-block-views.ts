import { accounts } from "@k2b/cloud/services";
import { sql } from "bun";
import type { CalendarFilter } from "../frontend/[id]/_components/calendar/filter";
import { CALENDAR_MAX_DAYS } from "../frontend/[id]/_components/calendar/range";
import type { SpaceTimeBlock } from "../time-block-contracts";
import { get, list, readerForUser } from "./time-blocks";

/** SSR and its navigation snapshots use the same authorized reads as the HTTP/agent surfaces. */
export async function taskTimeBlocks(itemId: string, userId: string): Promise<SpaceTimeBlock[]> {
  const user = await accounts.users.get({ id: userId });
  if (!user) throw new Error("User not found");
  const reader = readerForUser(user);
  const first = await list({ itemId, reader });
  if (!first.ok) throw new Error(first.error.message);
  const blocks = first.data.items;
  const pages = Math.ceil(first.data.total / first.data.perPage);
  for (let page = 2; page <= pages; page += 1) {
    const next = await list({ itemId, reader, page });
    if (!next.ok) throw new Error(next.error.message);
    blocks.push(...next.data.items);
  }
  return [...new Map(blocks.map((block) => [block.id, block])).values()];
}
export async function calendarTimeBlocks(params: {
  userId: string;
  spaceId?: string;
  from: string;
  to: string;
  mine?: boolean;
  filter?: CalendarFilter;
}): Promise<SpaceTimeBlock[]> {
  const user = await accounts.users.get({ id: params.userId });
  if (!user) throw new Error("User not found");
  const reader = readerForUser(user);
  // A full loaded year includes the last day's following night. Keep each public service query within
  // its one-year budget and read that trailing portion separately, rather than dropping the entire snapshot.
  const from = Date.parse(params.from),
    to = Date.parse(params.to);
  const maxRange = CALENDAR_MAX_DAYS * 86_400_000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > maxRange + 86_400_000)
    throw new Error("Invalid calendar range");
  const windows =
    to - from <= maxRange
      ? [{ from: params.from, to: params.to }]
      : [
          { from: params.from, to: new Date(from + maxRange).toISOString() },
          { from: new Date(from + maxRange).toISOString(), to: params.to },
        ];
  const blocks: SpaceTimeBlock[] = [];
  for (const window of windows) {
    const first = await list({ ...params, ...params.filter, ...window, reader });
    if (!first.ok) throw new Error(first.error.message);
    blocks.push(...first.data.items);
    // The first count bounds this read even while other people add blocks.
    const pages = Math.ceil(first.data.total / first.data.perPage);
    for (let page = 2; page <= pages; page += 1) {
      const next = await list({ ...params, ...params.filter, ...window, reader, page });
      if (!next.ok) throw new Error(next.error.message);
      blocks.push(...next.data.items);
    }
  }
  return [...new Map(blocks.map((block) => [block.id, block])).values()];
}

/** My work retains its existing five-today/thirty-upcoming display budget, including blocks beyond the current year. */
export async function myTimeBlocks(params: { userId: string; view: "mine" | "today" | "upcoming"; today: string; tomorrow: string }) {
  const user = await accounts.users.get({ id: params.userId });
  if (!user) throw new Error("User not found");
  const reader = readerForUser(user);
  const [counts] = await sql<{ today: number; upcoming: number }[]>`
    SELECT count(*) FILTER (WHERE starts_at < ${params.tomorrow}::timestamptz AND ends_at > ${params.today}::timestamptz)::int AS today,
      count(*) FILTER (WHERE starts_at >= ${params.tomorrow}::timestamptz)::int AS upcoming
    FROM spaces.time_blocks WHERE owner_id = ${user.id}::uuid`;
  if (params.view === "mine") return { blocks: [], counts: counts ?? { today: 0, upcoming: 0 } };
  const interval =
    params.view === "today"
      ? sql`starts_at < ${params.tomorrow}::timestamptz AND ends_at > ${params.today}::timestamptz`
      : sql`starts_at >= ${params.tomorrow}::timestamptz`;
  const rows = await sql<{ id: string }[]>`SELECT id FROM spaces.time_blocks WHERE owner_id = ${user.id}::uuid AND ${interval}
    ORDER BY starts_at, id LIMIT ${params.view === "today" ? 5 : 30}`;
  const blocks: SpaceTimeBlock[] = [];
  for (const row of rows) {
    const result = await get({ id: row.id, reader });
    if (result.ok) blocks.push(result.data);
    else if (result.error.status !== 404) throw new Error(result.error.message);
  }
  return { blocks, counts: counts ?? { today: 0, upcoming: 0 } };
}
