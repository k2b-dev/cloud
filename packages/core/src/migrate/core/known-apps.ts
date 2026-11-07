import { sql } from "@k2b/cloud";
import type { SQL } from "bun";

export const migrateKnownApps = async (db: SQL = sql): Promise<void> => {
  await db`CREATE SCHEMA IF NOT EXISTS core`.simple();
  await db`CREATE TABLE IF NOT EXISTS core.known_apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT 'ti ti-app',
    accent TEXT,
    release TEXT,
    routes JSONB NOT NULL DEFAULT '[]'::jsonb,
    nav_href TEXT,
    admin_href TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ,
    status_providers JSONB NOT NULL DEFAULT '{}'::jsonb,
    hidden_at TIMESTAMPTZ
  )`.simple();
};
