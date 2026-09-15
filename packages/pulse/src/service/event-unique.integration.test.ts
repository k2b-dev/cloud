import { expect, test } from "bun:test";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { queryEventAggregateData } from "./query-execution";
import type { EventQuery } from "../contracts";

const dbTest = process.env.PULSE_EVENT_AGGREGATION_DB_TEST === "1" ? test : test.skip;

dbTest(
  "unique events retain null-only groups and count source-local identities across calendar buckets",
  async () => {
    const baseId = crypto.randomUUID();
    const sources = [crypto.randomUUID(), crypto.randomUUID()];
    const start = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 2 * 86_400_000;
    await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,${newShortId()},'Unique identities')`;
    try {
      const rows = [
        { day: 0, source: 0, actor: "same", session: "same", group: "main" },
        { day: 0, source: 0, actor: "same", session: "same", group: "main" },
        { day: 0, source: 1, actor: "same", session: "same", group: "main" },
        { day: 0, source: 0, actor: null, session: "another", group: "main" },
        { day: 0, source: 0, actor: null, session: null, group: "anonymous" },
        { day: 0, source: 1, actor: null, session: null, group: "anonymous" },
        { day: 1, source: 0, actor: "same", session: "same", group: "main" },
      ];
      for (const row of rows) {
        await sql`INSERT INTO pulse.events(base_id,source_identity,ts,kind,actor_id,session_id,dimensions_hash,dimensions)
      VALUES(${baseId}::uuid,${sources[row.source]}::uuid,${new Date(start + row.day * 86_400_000 + 43_200_000)},'view',${row.actor},${row.session},'fixture',
      jsonb_build_object('group',${row.group}::text))`;
      }
      const query: EventQuery = {
        kind: "events",
        baseId,
        event: "view",
        aggregation: "unique_actor",
        bucket: "day",
        timeZone: "Europe/Berlin",
        from: new Date(start).toISOString(),
        to: new Date(start + 2 * 86_400_000).toISOString(),
        dimensions: {},
        groupBy: ["group"],
        limit: 500,
      };
      for (const aggregation of ["unique_actor", "unique_session"] as const) {
        const result = await queryEventAggregateData({ ...query, aggregation });
        if (!result.ok) throw Error(result.error.message);
        expect(result.data.map(({ value, group }) => ({ value, group }))).toEqual([
          { value: 0, group: { group: "anonymous" } },
          { value: aggregation === "unique_actor" ? 2 : 3, group: { group: "main" } },
          { value: 1, group: { group: "main" } },
        ]);
        expect(new Set(result.data.map((point) => point.bucket)).size).toBe(2);
        const total = await queryEventAggregateData({ ...query, aggregation, bucket: "all", timeZone: undefined, groupBy: [] });
        if (!total.ok) throw Error(total.error.message);
        expect(total.data.map((point) => point.value)).toEqual([aggregation === "unique_actor" ? 2 : 3]);
        const empty = await queryEventAggregateData({ ...query, aggregation, bucket: "all", timeZone: undefined, groupBy: [], event: "absent" });
        if (!empty.ok) throw Error(empty.error.message);
        expect(empty.data.map((point) => point.value)).toEqual([0]);
      }
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
    }
  },
  60_000,
);
