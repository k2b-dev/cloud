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
    const [policy] = await tx<
      { now: Date; earliest: Date }[]
    >`SELECT now(),now()-retention_days*interval '1 day' AS earliest FROM pulse.bases WHERE id=${query.baseId}::uuid`;
    if (!policy) return fail(err.notFound("Pulse base"));
    const range = resolveQueryTimeRange(query, policy.now.getTime());
    if (!range.ok) return range;
    if (range.data.from < policy.earliest) return fail(err.badInput("Event query starts before raw retention"));
    return read(tx, range.data);
  });
