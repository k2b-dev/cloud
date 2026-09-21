import { expect } from "bun:test";
import { logging } from "@k2b/cloud/services";
import { sql } from "bun";
import { testFor } from "../../../../../scripts/fixtures/test-infra";
import { migrateLogMetadataReader } from "./logging-metadata";

const readWebVitals = logging.webVitals;

const databaseTest = testFor("database");
databaseTest("legacy metadata with unsupported Unicode stays readable without changing the original", async () => {
  await migrateLogMetadataReader();
  for (const encoded of ['{"value":"\\u0000"}', '{"value":"\\ud800"}', '{"value":"\\udc00"}']) {
    const [row] = await sql<{ metadata: unknown; original: string }[]>`
      SELECT logging.object_metadata(to_jsonb(${encoded}::text)) AS metadata,
        to_jsonb(${encoded}::text) #>> '{}' AS original
    `;
    expect(row?.metadata).toBeNull();
    expect(row?.original).toBe(encoded);
  }
});

databaseTest("Web Vitals aggregate valid final reports with consistent windows, filters and percentiles", async () => {
  await migrateLogMetadataReader();
  const app = `vitals-${crypto.randomUUID()}`;
  const until = new Date("2026-09-14T12:00:00Z");
  const report = (id: string, name: string, value: unknown, route = "/test/:id") => ({ appId: app, routeTemplate: route, id, name, value });
  async function insert(body: unknown, time = "2026-09-14T11:30:00Z") {
    await sql`INSERT INTO logging.entries(level,source,message,metadata,created_at) VALUES ('info','web-vitals',${app},${JSON.stringify(body)}::jsonb,${new Date(time)})`;
  }
  try {
    await insert(report("a", "LCP", 999));
    await insert(report("a", "LCP", 100));
    await insert(report("b", "LCP", 200));
    await insert(report("c", "LCP", 300));
    await insert(report("d", "LCP", 400));
    await insert(report("zero", "CLS", 0));
    await insert(report("invalid", "INP", "100"));
    await insert(report("negative", "INP", -1));
    await insert(report("end", "INP", 777), until.toISOString());
    await insert(report("old", "INP", 888), "2026-09-14T10:59:59Z");
    await insert(report("boundary", "INP", 20), "2026-09-14T11:00:00Z");
    await insert(report("other", "LCP", 900, "/other"));
    await insert(report("a", "LCP", "invalid"), "2026-09-14T11:31:00Z");
    await insert("not JSON");
    await insert('{"value":1e10000000}');
    for (const encoded of ['{"value":"\\u0000"}', '{"value":"\\ud800"}', '{"value":"\\udc00"}']) {
      await sql`INSERT INTO logging.entries(level,source,message,metadata,created_at)
        VALUES ('info','web-vitals',${app},to_jsonb(${encoded}::text),'2026-09-14T11:30:00Z'::timestamptz)`;
    }
    await sql`UPDATE logging.entries SET metadata = (metadata #>> '{}')::jsonb WHERE source='web-vitals' AND message=${app} AND metadata #>> '{}' LIKE '%"zero"%'`;
    const result = await readWebVitals({ range: "1h", appId: app, route: "/test/:id" }, until);
    expect(result.summary.find((row) => row.name === "LCP")).toEqual({ name: "LCP", count: 4, p75: 325 });
    expect(result.summary.find((row) => row.name === "CLS")).toEqual({ name: "CLS", count: 1, p75: 0 });
    expect(result.summary.find((row) => row.name === "INP")).toEqual({ name: "INP", count: 1, p75: 20 });
    expect(result.totalRoutes).toBe(1);
    expect(result.routes).toHaveLength(3);
    expect(result.series.reduce((total, row) => total + row.count, 0)).toBe(6);
    expect((await readWebVitals({ range: "1h", appId: app }, until)).totalRoutes).toBe(2);
    expect((await readWebVitals({ range: "1h", appId: app, page: 2 }, until)).routes).toEqual([]);
    expect((await readWebVitals({ range: "1h", appId: app, route: "/missing" }, until)).summary).toEqual([]);
    for (let i = 0; i < 51; i++) await insert(report(`page-${i}`, "CLS", 0.1, `/page/${String(i).padStart(2, "0")}`));
    const first = await readWebVitals({ range: "1h", appId: app }, until);
    const second = await readWebVitals({ range: "1h", appId: app, page: 2 }, until);
    expect(first.totalRoutes).toBe(53);
    expect(new Set(first.routes.map((row) => row.route)).size).toBe(50);
    expect(new Set(second.routes.map((row) => row.route)).size).toBe(3);
    expect(second.routes.every((row) => !first.routes.some((previous) => previous.route === row.route))).toBe(true);
    expect(second.summary).toEqual(first.summary);
  } finally {
    await sql`DELETE FROM logging.entries WHERE source='web-vitals' AND message=${app}`;
  }
});
