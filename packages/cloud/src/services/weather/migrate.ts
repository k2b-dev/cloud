import { sql } from "bun";
import { backfillWeatherLocationShortIds } from "./short-id";

export const migrate = async (): Promise<void> => {
  await sql`
    CREATE TABLE IF NOT EXISTS weather_locations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT,
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      state TEXT,
      lat DOUBLE PRECISION NOT NULL,
      lon DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  await sql`ALTER TABLE weather_locations ADD COLUMN IF NOT EXISTS provenance JSONB`.simple();
  console.log("  ✓ weather_locations table");

  await sql`ALTER TABLE weather_locations ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_weather_locations_short_id ON weather_locations(short_id)`.simple();

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('cloud.weather.location-short-id-backfill'))`;
    const filled = await backfillWeatherLocationShortIds(tx);
    if (filled > 0) console.log(`  ✓ weather location short_id backfill: ${filled}`);
    await tx`ALTER TABLE weather_locations ALTER COLUMN short_id SET NOT NULL`;
    await tx`ALTER TABLE weather_locations DROP CONSTRAINT IF EXISTS weather_locations_short_id_format`;
    await tx`
      ALTER TABLE weather_locations
      ADD CONSTRAINT weather_locations_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$')
    `;
  });

  await sql`
    CREATE INDEX IF NOT EXISTS idx_weather_locations_user
    ON weather_locations(user_id)
  `.simple();
  console.log("  ✓ weather_locations index");

  await sql`
    CREATE INDEX IF NOT EXISTS idx_weather_locations_user_created
    ON weather_locations(user_id, created_at, id)
  `.simple();
  console.log("  ✓ weather_locations pagination index");
};
