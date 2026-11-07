import { crypto } from "@k2b/stdlib";
import { sql } from "../../runtime/clients";

import { isUniqueViolation } from "../postgres";

export const WEATHER_LOCATION_SHORT_ID_PATTERN = /^[0-9A-Za-z]{6}$/;

const SHORT_ID_LENGTH = 6;
const MAX_ATTEMPTS = 10;
const BACKFILL_BATCH_SIZE = 500;
const UNIQUE_CONSTRAINT = "idx_weather_locations_short_id";

type SqlExecutor = typeof sql;

export const newWeatherLocationShortId = (): string => crypto.common.readableId(SHORT_ID_LENGTH);

export const withWeatherLocationShortId = async <T>(write: (shortId: string) => Promise<T | null>): Promise<T> => {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const result = await write(newWeatherLocationShortId());
      if (result !== null) return result;
    } catch (error) {
      if (!isUniqueViolation(error, UNIQUE_CONSTRAINT)) throw error;
    }
  }
  throw new Error("Failed to allocate a Weather location short ID");
};

export const backfillWeatherLocationShortIds = async (db: SqlExecutor = sql): Promise<number> => {
  let filled = 0;
  for (;;) {
    const rows = await db<{ id: string }[]>`
      SELECT id
      FROM weather_locations
      WHERE short_id IS NULL
      ORDER BY id
      LIMIT ${BACKFILL_BATCH_SIZE}
      FOR UPDATE
    `;
    if (rows.length === 0) return filled;

    for (const row of rows) {
      await withWeatherLocationShortId(async (shortId) => {
        const updated = await db<{ id: string }[]>`
          UPDATE weather_locations
          SET short_id = ${shortId}
          WHERE id = ${row.id}::uuid
            AND short_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM weather_locations WHERE short_id = ${shortId})
          RETURNING id
        `;
        if (updated.length === 0) return null;
        filled++;
        return updated[0]!;
      });
    }
  }
};
