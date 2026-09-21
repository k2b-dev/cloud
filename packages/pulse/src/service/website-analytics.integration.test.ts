import { expect } from "bun:test";
import { sql } from "bun";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import type { EventQuery } from "../contracts";
import { newShortId } from "../lib/short-id";
import { queryEventMapData } from "./event-map-query";
import { ingestBatch } from "./ingest-writer";
import { queryEventAggregateData, queryEventsData } from "./query-execution";

const dbTest = testFor("database");

dbTest(
  "website analytics use exact windows, DST calendar days and source-local period uniques",
  async () => {
    const baseId = crypto.randomUUID(),
      sources = [crypto.randomUUID(), crypto.randomUUID()];
    await sql`INSERT INTO pulse.bases(id,short_id,name,retention_days) VALUES(${baseId}::uuid,${newShortId()},'Website proof',3650)`;
    for (const sourceId of sources)
      await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name) VALUES(${sourceId}::uuid,${newShortId()},${baseId}::uuid,'http_ingest','Website')`;
    const from = "2026-03-28T23:00:00Z",
      to = "2026-03-30T22:00:00Z";
    const query: EventQuery = {
      kind: "events",
      baseId,
      event: "page.viewed",
      from,
      to,
      bucket: "all",
      aggregation: "unique_actor",
      limit: 100,
      dimensions: {},
    };
    const event = (ts: string, identity = true, kind = "page.viewed") => ({
      kind,
      ts,
      ...(identity ? { actorId: "42", sessionId: "1" } : {}),
      resource: { type: "website", id: "example.test" },
      dimensions: { route: "/articles/:slug" },
      attributes: { geo: { lat: 48, lon: 10 } },
    });
    const points = async (input: EventQuery) => {
      const result = await queryEventAggregateData(input);
      if (!result.ok) throw Error(result.error.message);
      return result.data;
    };
    try {
      expect(
        (
          await ingestBatch({
            baseId,
            sourceId: sources[0]!,
            batch: {
              events: [
                event("2026-03-28T22:59:59Z"),
                event(from),
                event("2026-03-29T00:00:00Z"),
                event("2026-03-29T22:00:00Z"),
                event(to),
                event(new Date(Date.now() + 86400000).toISOString()),
              ],
            },
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await ingestBatch({
            baseId,
            sourceId: sources[1]!,
            batch: { events: [event("2026-03-29T01:00:00Z"), event("2026-03-29T02:00:00Z", false)] },
          })
        ).ok,
      ).toBe(true);
      expect((await points(query)).map((p) => p.value)).toEqual([2]);
      expect((await points({ ...query, aggregation: "unique_session" })).map((p) => p.value)).toEqual([2]);
      expect((await points({ ...query, aggregation: "count" })).map((p) => p.value)).toEqual([5]);
      const daily = await points({ ...query, aggregation: "count", bucket: "day", timeZone: "Europe/Berlin" });
      expect(daily.map((p) => [p.bucket, p.value])).toEqual([
        ["2026-03-28T23:00:00.000Z", 4],
        ["2026-03-29T22:00:00.000Z", 1],
      ]);
      expect(
        (await points({ ...query, aggregation: "unique_actor", bucket: "day", timeZone: "Europe/Berlin" })).map((p) => p.value),
      ).toEqual([2, 1]);
      const rows = await queryEventsData({ ...query, aggregation: "rows" });
      expect(rows.ok).toBe(true);
      if (rows.ok) expect(rows.data.length).toBe(5);
      const map = await queryEventMapData({
        query: { ...query, aggregation: "rows" },
        latitude: { role: "attribute", path: "geo.lat" },
        longitude: { role: "attribute", path: "geo.lon" },
        size: "count",
      });
      expect(map.ok).toBe(true);
      if (map.ok) expect(map.data[0]?.data[0]?.size).toBe(5);
      expect((await points({ ...query, event: "absent", aggregation: "count" })).map((p) => p.value)).toEqual([0]);
      expect((await points({ ...query, event: "absent", aggregation: "sum" })).map((p) => p.value)).toEqual([null]);
      expect(
        (await points({ kind: "events", baseId, event: "page.viewed", since: "1d", bucket: "all", aggregation: "count", limit: 100 })).map(
          (p) => p.value,
        ),
      ).toEqual([0]);
      await sql`DELETE FROM pulse.sources WHERE base_id=${baseId}::uuid`;
      expect((await points(query)).map((p) => p.value)).toEqual([2]);
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
    }
  },
  60000,
);

dbTest(
  "calendar autumn, week and month buckets preserve local boundaries across year changes",
  async () => {
    const baseId = crypto.randomUUID(),
      sourceId = crypto.randomUUID();
    await sql`INSERT INTO pulse.bases(id,short_id,name,retention_days) VALUES(${baseId}::uuid,${newShortId()},'Calendar proof',3650)`;
    await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name) VALUES(${sourceId}::uuid,${newShortId()},${baseId}::uuid,'http_ingest','Website')`;
    try {
      expect(
        (
          await ingestBatch({
            baseId,
            sourceId,
            batch: {
              events: ["2025-10-25T22:00:00Z", "2025-10-26T23:00:00Z", "2025-12-31T22:00:00Z", "2025-12-31T23:30:00Z"].map((ts) => ({
                kind: "page.viewed",
                ts,
              })),
            },
          })
        ).ok,
      ).toBe(true);
      const base: EventQuery = {
        kind: "events",
        baseId,
        event: "page.viewed",
        from: "2025-10-25T22:00:00Z",
        to: "2025-10-28T00:00:00Z",
        bucket: "day",
        timeZone: "Europe/Berlin",
        aggregation: "count",
        limit: 100,
      };
      const fall = await queryEventAggregateData(base);
      if (!fall.ok) throw Error(fall.error.message);
      expect(fall.data.map((p) => p.bucket)).toEqual(["2025-10-25T22:00:00.000Z", "2025-10-26T23:00:00.000Z"]);
      const winter = { ...base, from: "2025-12-01T00:00:00Z", to: "2026-01-02T00:00:00Z" };
      const months = await queryEventAggregateData({ ...winter, bucket: "month" });
      if (!months.ok) throw Error(months.error.message);
      expect(months.data.map((p) => p.bucket)).toEqual(["2025-11-30T23:00:00.000Z", "2025-12-31T23:00:00.000Z"]);
      const weeks = await queryEventAggregateData({ ...winter, bucket: "week" });
      if (!weeks.ok) throw Error(weeks.error.message);
      expect(weeks.data.map((p) => [p.bucket, p.value])).toEqual([["2025-12-28T23:00:00.000Z", 2]]);
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
    }
  },
  60000,
);
