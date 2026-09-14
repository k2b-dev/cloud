import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { logger, logging } from "./index";

const canUseLoggingDatabase = async (): Promise<boolean> => {
  try {
    const [row] = await sql<Array<{ entries: string | null }>>`
      SELECT to_regclass('logging.entries')::text AS entries
    `;
    return Boolean(row?.entries);
  } catch {
    return false;
  }
};

const suite = (await canUseLoggingDatabase()) ? describe : describe.skip;

suite("logging observability", () => {
  test("persists logger metadata as an object readable by the admin projection", async () => {
    const source = `observability-${crypto.randomUUID()}`;
    try {
      logger(source).warn("Fixture warning", {code:"fixture_warning",conversationId:"fixture"});
      let kind: string | undefined;
      for (let attempt = 0; attempt < 20 && !kind; attempt++) {
        const [row] = await sql<{kind:string}[]>`SELECT jsonb_typeof(metadata) AS kind FROM logging.entries WHERE source=${source}`;
        kind = row?.kind;
        if (!kind) await Bun.sleep(10);
      }
      expect(kind).toBe("object");
      const result = await logging.list({page:1,perPage:10,offset:0},{source,search:"fixture_warning"});
      expect(result.entries[0]?.metadata).toEqual({code:"fixture_warning",conversationId:"fixture"});
    } finally { await sql`DELETE FROM logging.entries WHERE source=${source}`; }
  });

  test("finds literal error codes in metadata without treating underscores as wildcards", async () => {
    const source = `observability-${crypto.randomUUID()}`;
    try {
      await sql`INSERT INTO logging.entries(level,source,message,metadata) VALUES
        ('error',${source},'dispatch failed','{"code":"queue_dispatch_failed"}'::jsonb),
        ('error',${source},'dispatch failed','{"code":"queueXdispatchXfailed"}'::jsonb)`;
      const filter = {source,search:"queue_dispatch_failed"};
      const result = await logging.list({page:1,perPage:10,offset:0},filter);
      expect(result.total).toBe(1);
      expect(result.entries[0]?.metadata?.code).toBe("queue_dispatch_failed");
      const points = await logging.timeseries({...filter,sinceHours:24});
      expect(points.reduce((sum,point)=>sum+point.total,0)).toBe(1);
    } finally { await sql`DELETE FROM logging.entries WHERE source=${source}`; }
  });

  test("returns bounded, gap-filled level buckets with the list filters applied", async () => {
    const source = `observability-${crypto.randomUUID()}`;
    try {
      await sql`
        INSERT INTO logging.entries (level, source, message, metadata, created_at)
        VALUES
          ('info', ${source}, 'fixture accepted', '{"kind":"fixture"}'::jsonb, now() - INTERVAL '3 hours'),
          ('warn', ${source}, 'fixture delayed', '{"kind":"fixture"}'::jsonb, now() - INTERVAL '2 hours'),
          ('error', ${source}, 'fixture failed', '{"kind":"fixture"}'::jsonb, now() - INTERVAL '1 hour')
      `;

      const points = await logging.timeseries({ sources: [source], search: "fixture", sinceHours: 24 });
      expect(points.length).toBeGreaterThanOrEqual(24);
      expect(points.length).toBeLessThanOrEqual(26);
      expect(points.every((point, index) => index === 0 || point.at >= points[index - 1]!.at)).toBe(true);
      expect(points.reduce((sum, point) => sum + point.total, 0)).toBe(3);
      expect(points.reduce((sum, point) => sum + point.error, 0)).toBe(1);
      expect(points.reduce((sum, point) => sum + point.warn, 0)).toBe(1);

      const errors = await logging.timeseries({ source, level: "error", sinceHours: 24 });
      expect(errors.reduce((sum, point) => sum + point.total, 0)).toBe(1);
      expect(errors.every((point) => point.debug === 0 && point.info === 0 && point.warn === 0)).toBe(true);
    } finally {
      await sql`DELETE FROM logging.entries WHERE source = ${source}`;
    }
  });
});
