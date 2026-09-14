import { sql } from "bun";
import { z } from "zod";

const ranges = {
  "1h": { hours: 1, bucket: 60 },
  "6h": { hours: 6, bucket: 300 },
  "24h": { hours: 24, bucket: 900 },
  "7d": { hours: 168, bucket: 3600 },
  "30d": { hours: 720, bucket: 21600 },
} as const;
const querySchema = z.object({
  range: z.enum(["1h", "6h", "24h", "7d", "30d"]).default("24h"),
  appId: z.string().max(64).default(""),
  route: z.string().max(200).default(""),
  page: z.number().int().min(1).max(100000).default(1),
});
export type WebVitalsQuery = z.input<typeof querySchema>;
export type WebVitalName = "LCP" | "INP" | "CLS";
export type WebVitalMetric = { name: WebVitalName; count: number; p75: number };
export type WebVitalsOverview = {
  summary: WebVitalMetric[];
  series: (WebVitalMetric & { bucket: number })[];
  routes: (WebVitalMetric & { appId: string; route: string })[];
  totalRoutes: number;
  page: number;
  perPage: number;
};

/** Admin diagnostics. Deduplicate the last valid report inside [since, until).
 * Attribute it to its last receipt time; this is not navigation-start time.
 * Only aggregates leave Postgres. Retention applies before this read.
 */
export async function readWebVitals(input: WebVitalsQuery, until = new Date()): Promise<WebVitalsOverview> {
  const query = querySchema.parse(input);
  const { hours, bucket } = ranges[query.range];
  const since = new Date(until.getTime() - hours * 3600000);
  const perPage = 50;
  const [result] = await sql<Omit<WebVitalsOverview, "page" | "perPage">[]>`
    WITH stored AS MATERIALIZED (
      SELECT id, created_at,
        logging.object_metadata(metadata) AS metadata
      FROM logging.entries
      WHERE source = 'web-vitals' AND level = 'info' AND created_at >= ${since} AND created_at < ${until}
    ), candidates AS MATERIALIZED (
      SELECT id, created_at, metadata->>'appId' AS app, metadata->>'routeTemplate' AS route,
        metadata->>'name' AS name, metadata->>'id' AS metric_id,
        CASE WHEN jsonb_typeof(metadata->'value') = 'number' THEN (metadata->>'value')::numeric END AS value
      FROM stored
      WHERE jsonb_typeof(metadata->'appId') = 'string' AND metadata->>'appId' ~ '^[a-z0-9-]{1,64}$'
        AND jsonb_typeof(metadata->'routeTemplate') = 'string'
        AND length(metadata->>'routeTemplate') BETWEEN 1 AND 200 AND metadata->>'routeTemplate' ~ '^/[a-zA-Z0-9_/:.*-]*$'
        AND jsonb_typeof(metadata->'id') = 'string' AND length(metadata->>'id') BETWEEN 1 AND 100
        AND metadata->>'name' IN ('LCP','INP','CLS')
        AND (${query.appId} = '' OR metadata->>'appId' = ${query.appId})
        AND (${query.route} = '' OR metadata->>'routeTemplate' = ${query.route})
    ), latest AS MATERIALIZED (
      SELECT DISTINCT ON (app, route, name, metric_id) app, route, name, value::double precision AS value, created_at
      FROM candidates WHERE value >= 0 AND value <= 1.7976931348623157e308::numeric
      ORDER BY app, route, name, metric_id, created_at DESC, id DESC
    ), route_stats AS MATERIALIZED (
      SELECT app, route, name, count(*)::int AS count,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY value) AS p75
      FROM latest GROUP BY app, route, name
    ), route_keys AS MATERIALIZED (
      SELECT DISTINCT app, route FROM route_stats ORDER BY app, route LIMIT ${perPage} OFFSET ${(query.page - 1) * perPage}
    )
    SELECT
      COALESCE((SELECT jsonb_agg(s) FROM (SELECT name, count(*)::int AS count, percentile_cont(0.75) WITHIN GROUP (ORDER BY value) AS p75 FROM latest GROUP BY name ORDER BY name) s), '[]'::jsonb) AS summary,
      COALESCE((SELECT jsonb_agg(s ORDER BY s.bucket, s.name) FROM (SELECT name,
        floor(extract(epoch FROM created_at) / ${bucket}) * ${bucket} * 1000 AS bucket,
        count(*)::int AS count, percentile_cont(0.75) WITHIN GROUP (ORDER BY value) AS p75
        FROM latest GROUP BY name, bucket) s), '[]'::jsonb) AS series,
      COALESCE((SELECT jsonb_agg(s ORDER BY s."appId", s.route, s.name) FROM (
        SELECT l.app AS "appId", l.route, l.name, l.count, l.p75
        FROM route_stats l JOIN route_keys k USING (app, route)
      ) s), '[]'::jsonb) AS routes,
      (SELECT count(*)::int FROM (SELECT DISTINCT app, route FROM route_stats) r) AS "totalRoutes"
  `;
  if (!result) throw new Error("Web Vitals aggregation returned no result");
  return { ...result, page: query.page, perPage };
}
