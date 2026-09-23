import { err, fail, type Result } from "@k2b/cloud/server";
import { sql } from "bun";
import type { EventQuery } from "../contracts";
import { resolveQueryTimeRange } from "../query-dsl/time-window";

type Window = { from: Date; to: Date; durationMs: number };
export const withEventQuerySnapshot = <T>(
  query: EventQuery,
  read: (db: typeof sql, range: Window) => Promise<Result<T>>,
): Promise<Result<T>> =>
  sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (tx) => {
    // now() has microsecond precision; rounding up to the next millisecond keeps every event visible in this snapshot
    // inside a window that ends "now" (a JavaScript Date would truncate and drop events from the last millisecond).
    const [policy] = await tx<
      { nowMs: number; earliest: Date }[]
    >`SELECT ceil(extract(epoch FROM now())*1000)::float8 AS "nowMs",now()-retention_days*interval '1 day' AS earliest FROM pulse.bases WHERE id=${query.baseId}::uuid`;
    if (!policy) return fail(err.notFound("Pulse base"));
    const range = resolveQueryTimeRange(query, policy.nowMs);
    if (!range.ok) return range;
    if (range.data.from < policy.earliest) return fail(err.badInput("Event query starts before raw retention"));
    return read(tx, range.data);
  });
