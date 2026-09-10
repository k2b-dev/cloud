import { sql } from "bun";
export async function migrate() {
  await sql`CREATE SCHEMA IF NOT EXISTS kit`.simple();
  await sql`CREATE TABLE IF NOT EXISTS kit.projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), short_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
    sdk_version INTEGER NOT NULL DEFAULT 1, persistence_enabled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.simple();
  await sql`CREATE TABLE IF NOT EXISTS kit.project_files (
    project_id UUID NOT NULL REFERENCES kit.projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(project_id,path)
  )`.simple();
  await sql`CREATE TABLE IF NOT EXISTS kit.project_access (
    project_id UUID NOT NULL REFERENCES kit.projects(id) ON DELETE CASCADE,
    access_id UUID NOT NULL REFERENCES auth.access(id) ON DELETE CASCADE, PRIMARY KEY(project_id,access_id)
  )`.simple();
  await sql`CREATE INDEX IF NOT EXISTS kit_access_id ON kit.project_access(access_id)`.simple();
  await sql`CREATE TABLE IF NOT EXISTS kit.project_databases (
    project_id UUID PRIMARY KEY REFERENCES kit.projects(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT false,
    namespace TEXT UNIQUE,
    pending_namespace TEXT UNIQUE,
    generation INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.simple();
  await sql`CREATE TABLE IF NOT EXISTS kit.database_cleanup (
    namespace TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    error TEXT
  )`.simple();
}
