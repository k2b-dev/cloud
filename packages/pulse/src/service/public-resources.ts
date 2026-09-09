import { toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { SHORT_ID_REGEX } from "../lib/short-id";

export type PulsePublicResourceTable = "bases" | "sources" | "dashboards" | "saved_queries";
export type PulseBaseResourceTable = Exclude<PulsePublicResourceTable, "bases">;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const resolvePublicId = async (table: PulsePublicResourceTable, shortId: string): Promise<string | null> => {
  if (!SHORT_ID_REGEX.test(shortId)) return null;
  let rows: { id: string }[];
  switch (table) {
    case "bases":
      rows = await sql`SELECT id FROM pulse.bases WHERE short_id = ${shortId}`;
      break;
    case "sources":
      rows = await sql`SELECT id FROM pulse.sources WHERE short_id = ${shortId}`;
      break;
    case "dashboards":
      rows = await sql`SELECT id FROM pulse.dashboards WHERE short_id = ${shortId}`;
      break;
    case "saved_queries":
      rows = await sql`SELECT id FROM pulse.saved_queries WHERE short_id = ${shortId}`;
      break;
  }
  return rows[0]?.id ?? null;
};

export const resolveBasePublicId = async (table: PulseBaseResourceTable, baseId: string, shortId: string): Promise<string | null> => {
  if (!SHORT_ID_REGEX.test(shortId)) return null;
  let rows: { id: string }[];
  switch (table) {
    case "sources":
      rows = await sql`SELECT id FROM pulse.sources WHERE base_id = ${baseId}::uuid AND short_id = ${shortId}`;
      break;
    case "dashboards":
      rows = await sql`SELECT id FROM pulse.dashboards WHERE base_id = ${baseId}::uuid AND short_id = ${shortId}`;
      break;
    case "saved_queries":
      rows = await sql`SELECT id FROM pulse.saved_queries WHERE base_id = ${baseId}::uuid AND short_id = ${shortId}`;
      break;
  }
  return rows[0]?.id ?? null;
};

export const resolveExistingBasePublicIds = async (
  table: PulseBaseResourceTable,
  baseId: string,
  values: readonly string[],
): Promise<Map<string, string>> => {
  const input = [...new Set(values.filter((value) => SHORT_ID_REGEX.test(value)))];
  if (input.length === 0) return new Map();
  const array = toPgTextArray(input);
  let rows: { id: string; short_id: string }[];
  switch (table) {
    case "sources":
      rows = await sql`SELECT id, short_id FROM pulse.sources WHERE base_id = ${baseId}::uuid AND short_id = ANY(${array}::text[])`;
      break;
    case "dashboards":
      rows = await sql`SELECT id, short_id FROM pulse.dashboards WHERE base_id = ${baseId}::uuid AND short_id = ANY(${array}::text[])`;
      break;
    case "saved_queries":
      rows = await sql`SELECT id, short_id FROM pulse.saved_queries WHERE base_id = ${baseId}::uuid AND short_id = ANY(${array}::text[])`;
      break;
  }
  return new Map(rows.map((row) => [row.short_id, row.id]));
};

export const resolveBasePublicIds = async (
  table: PulseBaseResourceTable,
  baseId: string,
  values: readonly string[],
): Promise<Map<string, string> | null> => {
  const input = [...new Set(values)];
  if (input.some((value) => !SHORT_ID_REGEX.test(value))) return null;
  const resolved = await resolveExistingBasePublicIds(table, baseId, input);
  return resolved.size === input.length ? resolved : null;
};

export const shortIds = async (
  table: PulsePublicResourceTable,
  values: readonly (string | null | undefined)[],
): Promise<Map<string, string>> => {
  const ids = [...new Set(values.filter((value): value is string => Boolean(value)))];
  if (ids.length === 0) return new Map();
  const array = toPgUuidArray(ids);
  let rows: { id: string; short_id: string }[];
  switch (table) {
    case "bases":
      rows = await sql`SELECT id, short_id FROM pulse.bases WHERE id = ANY(${array}::uuid[])`;
      break;
    case "sources":
      rows = await sql`SELECT id, short_id FROM pulse.sources WHERE id = ANY(${array}::uuid[])`;
      break;
    case "dashboards":
      rows = await sql`SELECT id, short_id FROM pulse.dashboards WHERE id = ANY(${array}::uuid[])`;
      break;
    case "saved_queries":
      rows = await sql`SELECT id, short_id FROM pulse.saved_queries WHERE id = ANY(${array}::uuid[])`;
      break;
  }
  return new Map(rows.map((row) => [row.id, row.short_id]));
};

export const requireShortId = (ids: Map<string, string>, id: string): string => {
  const shortId = ids.get(id);
  if (!shortId) throw new Error(`Missing public Pulse ID for ${id}`);
  return shortId;
};

export const projectBases = async <T extends { id: string }>(items: T[]): Promise<T[]> => {
  const ids = await shortIds(
    "bases",
    items.map((item) => item.id),
  );
  return items.map((item) => ({ ...item, id: requireShortId(ids, item.id) }));
};

export const projectSources = async <T extends { id: string; baseId: string }>(items: T[]): Promise<T[]> => {
  const [ids, bases] = await Promise.all([
    shortIds(
      "sources",
      items.map((item) => item.id),
    ),
    shortIds(
      "bases",
      items.map((item) => item.baseId),
    ),
  ]);
  return items.map((item) => ({ ...item, id: requireShortId(ids, item.id), baseId: requireShortId(bases, item.baseId) }));
};

export const projectDashboards = async <T extends { id: string; baseId: string }>(items: T[]): Promise<T[]> => {
  const [ids, bases] = await Promise.all([
    shortIds(
      "dashboards",
      items.map((item) => item.id),
    ),
    shortIds(
      "bases",
      items.map((item) => item.baseId),
    ),
  ]);
  return items.map((item) => ({ ...item, id: requireShortId(ids, item.id), baseId: requireShortId(bases, item.baseId) }));
};

export const projectSavedQueries = async <T extends { id: string; baseId: string }>(items: T[]): Promise<T[]> => {
  const [ids, bases] = await Promise.all([
    shortIds(
      "saved_queries",
      items.map((item) => item.id),
    ),
    shortIds(
      "bases",
      items.map((item) => item.baseId),
    ),
  ]);
  return items.map((item) => ({ ...item, id: requireShortId(ids, item.id), baseId: requireShortId(bases, item.baseId) }));
};

type ShortIdLookup = typeof shortIds;

export const projectDashboardSnapshot = async <T extends { dashboard: { id: string } }>(
  snapshot: T,
  lookup: ShortIdLookup = shortIds,
): Promise<T> => {
  const ids = await lookup("dashboards", [snapshot.dashboard.id]);
  return { ...snapshot, dashboard: { ...snapshot.dashboard, id: requireShortId(ids, snapshot.dashboard.id) } };
};

export const buildResourceRefId = (baseShortId: string, resourceKey: string): string => `${baseShortId}/${resourceKey}`;

export const parseResourceRefId = (value: string): { baseShortId: string; resourceKey: string } | null => {
  if (value.length < 8 || value[6] !== "/") return null;
  const baseShortId = value.slice(0, 6);
  const resourceKey = value.slice(7);
  return SHORT_ID_REGEX.test(baseShortId) && resourceKey ? { baseShortId, resourceKey } : null;
};

const relationTable: Record<string, PulsePublicResourceTable | undefined> = {
  baseId: "bases",
  sourceId: "sources",
  dashboardId: "dashboards",
  savedQueryId: "saved_queries",
};

const opaqueRelationKeys = new Set([
  "attributes",
  "dimensions",
  "group",
  "initialDashboardMaps",
  "initialMetricWidgetPoints",
  "maps",
  "payload",
  "points",
  "sensitive",
  "value",
]);

const collectRelations = (value: unknown, relations: Map<PulsePublicResourceTable, Set<string>>): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectRelations(item, relations);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (opaqueRelationKeys.has(key)) continue;
    const table = relationTable[key];
    if (table && typeof nested === "string" && UUID_REGEX.test(nested)) relations.get(table)!.add(nested);
    else if (key === "sourceIds" && Array.isArray(nested)) {
      for (const id of nested) if (typeof id === "string" && UUID_REGEX.test(id)) relations.get("sources")!.add(id);
    } else collectRelations(nested, relations);
  }
};

const replaceRelations = (value: unknown, maps: Map<PulsePublicResourceTable, Map<string, string>>): unknown => {
  if (Array.isArray(value)) return value.map((item) => replaceRelations(item, maps));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => {
      if (opaqueRelationKeys.has(key)) return [key, nested];
      const table = relationTable[key];
      if (table && typeof nested === "string" && UUID_REGEX.test(nested)) return [key, requireShortId(maps.get(table)!, nested)];
      if (key === "sourceIds" && Array.isArray(nested)) {
        return [
          key,
          nested.flatMap((id) => {
            if (typeof id !== "string" || !UUID_REGEX.test(id)) return [id];
            const shortId = maps.get("sources")!.get(id);
            return shortId ? [shortId] : [];
          }),
        ];
      }
      return [key, replaceRelations(nested, maps)];
    }),
  );
};

export const projectPublicRelations = async <T>(value: T, lookup: ShortIdLookup = shortIds): Promise<T> => {
  const relations = new Map<PulsePublicResourceTable, Set<string>>([
    ["bases", new Set()],
    ["sources", new Set()],
    ["dashboards", new Set()],
    ["saved_queries", new Set()],
  ]);
  collectRelations(value, relations);
  const maps = new Map(await Promise.all([...relations].map(async ([table, ids]) => [table, await lookup(table, [...ids])] as const)));
  return replaceRelations(value, maps) as T;
};
