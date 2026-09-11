import { sql } from "bun";

export async function migrateArtifacts() {
  await sql`CREATE SCHEMA IF NOT EXISTS assistant`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.simple();
  await sql`ALTER TABLE assistant.artifacts ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.artifact_revisions (
    artifact_id UUID NOT NULL REFERENCES assistant.artifacts(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision > 0),
    source JSONB NOT NULL,
    source_bytes INTEGER NOT NULL CHECK(source_bytes >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(artifact_id, revision)
  )`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.artifact_access (
    artifact_id UUID NOT NULL REFERENCES assistant.artifacts(id) ON DELETE CASCADE,
    access_id UUID NOT NULL REFERENCES auth.access(id) ON DELETE CASCADE,
    PRIMARY KEY(artifact_id, access_id)
  )`.simple();
  await sql`CREATE INDEX IF NOT EXISTS assistant_artifact_access_id ON assistant.artifact_access(access_id)`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.artifact_client_calls (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    turn_id UUID NOT NULL, call_id TEXT NOT NULL,
    client_id UUID NOT NULL, input JSONB NOT NULL, result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id, turn_id, call_id)
  )`.simple();
  // No conversation foreign key owns an artifact. Chat references are ordinary URLs.
}
