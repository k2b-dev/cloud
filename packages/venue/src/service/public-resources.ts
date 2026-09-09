import { toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { SHORT_ID_REGEX } from "../lib/short-id";

export type VenueResourceTable = "venues" | "openingRules" | "overrides" | "templates" | "assignments" | "sections";
export type VenueOwnedResourceTable = Exclude<VenueResourceTable, "venues">;

const tableName: Record<VenueResourceTable, string> = {
  venues: "venues",
  openingRules: "opening_rules",
  overrides: "date_overrides",
  templates: "shift_templates",
  assignments: "shift_assignments",
  sections: "public_sections",
};

export const resolvePublicId = async (table: VenueResourceTable, shortId: string): Promise<string | null> => {
  if (!SHORT_ID_REGEX.test(shortId)) return null;
  const rows = (await sql.unsafe(`SELECT id FROM venue.${tableName[table]} WHERE short_id = $1`, [shortId])) as { id: string }[];
  return rows[0]?.id ?? null;
};

export const resolveVenuePublicId = async (table: VenueOwnedResourceTable, venueId: string, shortId: string): Promise<string | null> => {
  if (!SHORT_ID_REGEX.test(shortId)) return null;
  const rows = (await sql.unsafe(`SELECT id FROM venue.${tableName[table]} WHERE venue_id = $1::uuid AND short_id = $2`, [
    venueId,
    shortId,
  ])) as { id: string }[];
  return rows[0]?.id ?? null;
};

export const publicIds = async (table: VenueResourceTable, ids: (string | null | undefined)[]): Promise<Map<string, string>> => {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const rows = (await sql.unsafe(`SELECT id, short_id FROM venue.${tableName[table]} WHERE id = ANY($1::uuid[])`, [
    toPgUuidArray(unique),
  ])) as { id: string; short_id: string }[];
  return new Map(rows.map((row) => [row.id, row.short_id]));
};

export const resolvePublicIds = async (table: VenueResourceTable, ids: string[]): Promise<string[] | null> => {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids)];
  if (unique.some((id) => !SHORT_ID_REGEX.test(id))) return null;
  const rows = (await sql.unsafe(`SELECT id, short_id FROM venue.${tableName[table]} WHERE short_id = ANY($1::text[])`, [
    toPgTextArray(unique),
  ])) as { id: string; short_id: string }[];
  const byShort = new Map(rows.map((row) => [row.short_id, row.id]));
  return unique.every((id) => byShort.has(id)) ? ids.map((id) => byShort.get(id)!) : null;
};

export const requirePublicId = (ids: Map<string, string>, id: string): string => {
  const value = ids.get(id);
  if (!value) throw new Error(`Missing public ID for Venue resource ${id}`);
  return value;
};
