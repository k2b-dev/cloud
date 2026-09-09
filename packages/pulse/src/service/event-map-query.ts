import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type { EventQuery, PulseMapFieldSelector, PulseMapSeries } from "../contracts";
import { intervalToMs } from "../query-dsl";
import { jsonbObject, normalizeDimensions } from "./telemetry-values";

const MAX_MAP_POINTS = 1_000;
const NUMBER_PATTERN = "^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$";

export type EventMapQuery = {
  query: EventQuery;
  latitude: PulseMapFieldSelector;
  longitude: PulseMapFieldSelector;
  label?: PulseMapFieldSelector;
  series?: PulseMapFieldSelector;
  size: "count" | "sum";
};

type EventMapRow = {
  latitude: number | string;
  longitude: number | string;
  label: string | null;
  series: string | null;
  size: number | string;
};

const selectorSql = (selector: PulseMapFieldSelector) =>
  selector.role === "dimension"
    ? sql`event.dimensions ->> ${selector.path}`
    : sql`event.attributes #>> ${toPgTextArray(selector.path.split("."))}::text[]`;

const optionalSelectorSql = (selector: PulseMapFieldSelector | undefined) => (selector ? selectorSql(selector) : sql`NULL::text`);

const rowsToSeries = (rows: EventMapRow[]): PulseMapSeries[] => {
  const grouped = new Map<string, PulseMapSeries>();
  for (const row of rows) {
    const seriesLabel = row.series ?? "";
    const current = grouped.get(seriesLabel) ?? {
      ...(seriesLabel ? { label: seriesLabel } : {}),
      data: [],
    };
    current.data.push({
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      ...(row.label ? { label: row.label } : {}),
      size: Number(row.size),
    });
    grouped.set(seriesLabel, current);
  }
  return [...grouped.values()];
};

export const queryEventMapData = async (input: EventMapQuery): Promise<Result<PulseMapSeries[]>> => {
  const { query } = input;
  if ((query.aggregation ?? "rows") !== "rows") return fail(err.badInput("Map widgets require an event rows query"));
  const sinceMs = intervalToMs(query.since);
  if (!sinceMs) return fail(err.badInput("Use compact durations like 5m, 1h, or 7d"));

  const since = new Date(Date.now() - sinceMs);
  const dimensions = normalizeDimensions(query.dimensions);
  const latitude = selectorSql(input.latitude);
  const longitude = selectorSql(input.longitude);
  const label = optionalSelectorSql(input.label);
  const series = optionalSelectorSql(input.series);
  const size = input.size === "sum" ? sql`GREATEST(SUM(COALESCE(value, 0)), 0)::double precision` : sql`COUNT(*)::double precision`;
  const limit = Math.min(MAX_MAP_POINTS, Math.max(1, query.limit));

  const rows = await sql<EventMapRow[]>`
    WITH extracted AS (
      SELECT
        ${latitude} AS latitude_text,
        ${longitude} AS longitude_text,
        ${label} AS label,
        ${series} AS series,
        event.value
      FROM pulse.events event
      WHERE event.base_id = ${query.baseId}::uuid
        AND (${query.event ?? null}::text IS NULL OR event.kind = ${query.event ?? null})
        AND (${query.sourceId ?? null}::uuid IS NULL OR event.source_id = ${query.sourceId ?? null}::uuid)
        AND (${query.entityId ?? null}::text IS NULL OR event.entity_id = ${query.entityId ?? null})
        AND (${query.entityType ?? null}::text IS NULL OR event.entity_type = ${query.entityType ?? null})
        AND event.dimensions @> (${jsonbObject(dimensions)}::jsonb #>> '{}')::jsonb
        AND event.ts >= ${since}
    ),
    located AS (
      SELECT
        latitude_text::double precision AS latitude,
        longitude_text::double precision AS longitude,
        NULLIF(LEFT(label, 240), '') AS label,
        NULLIF(LEFT(series, 240), '') AS series,
        value
      FROM extracted
      WHERE latitude_text ~ ${NUMBER_PATTERN}
        AND longitude_text ~ ${NUMBER_PATTERN}
        AND latitude_text::double precision BETWEEN -90 AND 90
        AND longitude_text::double precision BETWEEN -180 AND 180
    )
    SELECT latitude, longitude, label, series, ${size} AS size
    FROM located
    GROUP BY latitude, longitude, label, series
    ORDER BY size DESC, latitude ASC, longitude ASC, label ASC NULLS LAST, series ASC NULLS LAST
    LIMIT ${limit}
  `;

  return ok(rowsToSeries(rows));
};
