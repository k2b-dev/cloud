import { err, fail, ok, type PageParams, type Paginated, paginate, type Result } from "@k2b/stdlib";
import type { GeoProvenance } from "../../contracts/geo";
import { sql } from "../../runtime/clients";
import { logger } from "../logging";
import { withWeatherLocationShortId } from "./short-id";

const log = logger("weather");

/**
 * The most places one person may save: the place list shows them all at once (the sidebar of the weather app), and v2
 * lists show at most 100 rows without paging. Creating one more is refused; reading without a page reads at most these.
 */
export const WEATHER_SAVED_PLACES_MAX = 100;

export type Location = {
  id: string;
  name: string;
  state: string | null;
  lat: number;
  lon: number;
  provenance?: GeoProvenance | null;
};

/**
 * Stores one user-owned weather location and returns the persisted row.
 */
const create = async (config: {
  userId: string;
  data: {
    name: string;
    state?: string;
    lat: number;
    lon: number;
    provenance?: GeoProvenance;
  };
}): Promise<Result<Location>> => {
  try {
    const location = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('cloud.weather.location-short-id-backfill'))`;
      // the lock above serializes every create, so counting here cannot race another save of the same person
      const [saved] = await tx<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM weather_locations WHERE user_id = ${config.userId}`;
      if ((saved?.count ?? 0) >= WEATHER_SAVED_PLACES_MAX) return "full" as const;
      return withWeatherLocationShortId(async (shortId) => {
        const [row] = await tx`
          INSERT INTO weather_locations (short_id, user_id, name, state, lat, lon, provenance)
          VALUES (${shortId}, ${config.userId}, ${config.data.name}, ${config.data.state ?? null}, ${config.data.lat}, ${config.data.lon}, (${config.data.provenance ? JSON.stringify(config.data.provenance) : null}::text)::jsonb)
          ON CONFLICT (short_id) DO NOTHING
          RETURNING short_id AS id, name, state, lat, lon, provenance
        `;
        return (row as Location | undefined) ?? null;
      });
    });
    if (location === "full") return fail(err.conflict(`At most ${WEATHER_SAVED_PLACES_MAX} places can be saved.`));
    return ok(location);
  } catch (error) {
    log.error("Failed to create location", {
      error: error instanceof Error ? error.message : String(error),
    });
    return fail(err.internal("Failed to create location"));
  }
};

/**
 * Deletes one saved location owned by the user and reports `NOT_FOUND` when no row matches.
 */
const remove = async (config: { id: string; userId: string }): Promise<Result<void>> => {
  try {
    const result = await sql`
      DELETE FROM weather_locations
      WHERE short_id = ${config.id} AND user_id = ${config.userId}
      RETURNING short_id
    `;

    if (result.length === 0) {
      return fail(err.notFound("Location"));
    }

    return ok();
  } catch (error) {
    log.error("Failed to delete location", {
      error: error instanceof Error ? error.message : String(error),
    });
    return fail(err.internal("Failed to delete location"));
  }
};

/**
 * Lists the saved weather locations of one user with optional search and pagination; without a page it reads the
 * first `WEATHER_SAVED_PLACES_MAX`, which is all of them for anyone who saved them here.
 */
const list = async (config: { userId: string; pagination?: PageParams; filter?: { query?: string } }): Promise<Paginated<Location>> => {
  const query = config.filter?.query?.trim().toLowerCase() ?? "";
  const queryMatch =
    query.length > 0
      ? sql`(
          POSITION(${query} IN LOWER(name)) > 0
          OR POSITION(${query} IN LOWER(COALESCE(state, ''))) > 0
        )`
      : sql`true`;
  const pagination = config.pagination ? paginate(config.pagination) : null;

  const [countRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM weather_locations
    WHERE user_id = ${config.userId}
      AND ${queryMatch}
  `;

  const items = (await sql`
    SELECT short_id AS id, name, state, lat, lon, provenance
    FROM weather_locations
    WHERE user_id = ${config.userId}
      AND ${queryMatch}
    ORDER BY created_at ASC, id ASC
    LIMIT ${pagination?.perPage ?? WEATHER_SAVED_PLACES_MAX}
    OFFSET ${pagination?.offset ?? 0}
  `) as Location[];
  const total = countRow?.count ?? 0;
  const page = pagination?.page ?? 1;
  const perPage = pagination?.perPage ?? WEATHER_SAVED_PLACES_MAX;
  return {
    items,
    page,
    perPage,
    total,
    hasNext: page * perPage < total,
  };
};

/**
 * Returns one saved location for the owning user, or `null` if it is missing/inaccessible.
 */
const get = async (config: { id: string; userId: string }): Promise<Location | null> => {
  const [location] = await sql`
    SELECT short_id AS id, name, state, lat, lon, provenance
    FROM weather_locations
    WHERE short_id = ${config.id} AND user_id = ${config.userId}
  `;
  return (location as Location) ?? null;
};

export const weatherLocationsService = {
  /** The most places one person may save. */
  max: WEATHER_SAVED_PLACES_MAX,
  list,
  get,
  create,
  remove,
};
