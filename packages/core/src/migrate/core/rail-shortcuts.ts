import { type SQL, sql } from "bun";

/** Transactional cache generations also cover directory sync and cascading membership changes. */
export const migrate = async (db: SQL = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`CREATE TABLE IF NOT EXISTS auth.rail_state (
      singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
      revision INTEGER NOT NULL DEFAULT 0,
      cache_version UUID NOT NULL DEFAULT gen_random_uuid()
    )`.simple();
    await tx`INSERT INTO auth.rail_state(singleton) VALUES (true) ON CONFLICT DO NOTHING`;
    await tx`ALTER TABLE auth.rail_preferences ADD COLUMN IF NOT EXISTS cache_version UUID NOT NULL DEFAULT gen_random_uuid()`.simple();
    await tx`CREATE TABLE IF NOT EXISTS auth.rail_shortcuts (
      id TEXT PRIMARY KEY, position INTEGER NOT NULL, shortcut JSONB NOT NULL
    )`.simple();
    await tx`CREATE TABLE IF NOT EXISTS auth.rail_shortcut_access (
      shortcut_id TEXT NOT NULL REFERENCES auth.rail_shortcuts(id) ON DELETE CASCADE,
      access_id UUID PRIMARY KEY REFERENCES auth.access(id) ON DELETE CASCADE
    )`.simple();
    await tx`CREATE INDEX IF NOT EXISTS rail_shortcut_access_shortcut ON auth.rail_shortcut_access(shortcut_id)`.simple();
    await tx`CREATE OR REPLACE FUNCTION auth.bump_rail_cache() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE auth.rail_state SET cache_version = gen_random_uuid() WHERE singleton;
        RETURN NULL;
      END $$`.simple();
    await tx`CREATE OR REPLACE FUNCTION auth.bump_personal_rail_cache() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.cache_version = gen_random_uuid(); RETURN NEW; END $$`.simple();
    await tx`CREATE OR REPLACE TRIGGER rail_preferences_cache BEFORE UPDATE ON auth.rail_preferences
      FOR EACH ROW EXECUTE FUNCTION auth.bump_personal_rail_cache()`.simple();
    // Membership changes are rare. Invalidating all rail snapshots avoids tracking the
    // potentially unbounded transitive set of users affected by nested groups.
    for (const table of ["rail_shortcuts", "rail_shortcut_access", "user_groups_v2", "group_groups_v2", "groups"]) {
      await tx.unsafe(`CREATE OR REPLACE TRIGGER rail_cache AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON auth.${table}
        FOR EACH STATEMENT EXECUTE FUNCTION auth.bump_rail_cache()`);
    }
    await tx`CREATE OR REPLACE FUNCTION auth.bump_rail_access_cache() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM auth.rail_shortcut_access WHERE access_id = OLD.id) THEN
          UPDATE auth.rail_state SET cache_version = gen_random_uuid() WHERE singleton;
        END IF;
        IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
        RETURN OLD;
      END $$`.simple();
    await tx`CREATE OR REPLACE TRIGGER rail_access_cache BEFORE UPDATE OR DELETE ON auth.access
      FOR EACH ROW EXECUTE FUNCTION auth.bump_rail_access_cache()`.simple();
  });
};
