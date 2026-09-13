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
  await sql`ALTER TABLE assistant.artifacts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'app' CHECK(kind IN ('app','script'))`.simple();
  await sql`ALTER TABLE assistant.artifacts ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`.simple();
  await sql`ALTER TABLE assistant.artifacts
    ADD COLUMN IF NOT EXISTS published_revision INTEGER,
    ADD COLUMN IF NOT EXISTS published_title TEXT,
    ADD COLUMN IF NOT EXISTS published_description TEXT,
    ADD COLUMN IF NOT EXISTS forked_from_id UUID,
    ADD COLUMN IF NOT EXISTS forked_from_revision INTEGER`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.artifact_revisions (
    artifact_id UUID NOT NULL REFERENCES assistant.artifacts(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision > 0),
    source JSONB NOT NULL,
    source_bytes INTEGER NOT NULL CHECK(source_bytes >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(artifact_id, revision)
  )`.simple();
  await sql`ALTER TABLE assistant.artifacts
    ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT 'ti ti-app-window',
    ADD COLUMN IF NOT EXISTS published_icon TEXT,
    ADD COLUMN IF NOT EXISTS published_version INTEGER`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.artifact_publications (
    artifact_id UUID NOT NULL REFERENCES assistant.artifacts(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK(version > 0), revision INTEGER NOT NULL,
    title TEXT NOT NULL, description TEXT NOT NULL, icon TEXT NOT NULL,
    note TEXT NOT NULL, author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(artifact_id, version),
    FOREIGN KEY(artifact_id, revision) REFERENCES assistant.artifact_revisions(artifact_id, revision)
  )`.simple();
  await sql`INSERT INTO assistant.artifact_publications(artifact_id,version,revision,title,description,icon,note)
    SELECT id,1,published_revision,published_title,coalesce(published_description,''),icon,'Existing publication'
    FROM assistant.artifacts WHERE published_revision IS NOT NULL AND published_version IS NULL
    ON CONFLICT DO NOTHING`.simple();
  await sql`UPDATE assistant.artifacts SET published_version=1,published_icon=icon
    WHERE published_revision IS NOT NULL AND published_version IS NULL`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.artifact_access (
    artifact_id UUID NOT NULL REFERENCES assistant.artifacts(id) ON DELETE CASCADE,
    access_id UUID NOT NULL REFERENCES auth.access(id) ON DELETE CASCADE,
    PRIMARY KEY(artifact_id, access_id)
  )`.simple();
  await sql`CREATE INDEX IF NOT EXISTS assistant_artifact_access_id ON assistant.artifact_access(access_id)`.simple();
  await sql`UPDATE auth.access SET permission='admin' WHERE permission='write'
    AND id IN (SELECT access_id FROM assistant.artifact_access)`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.artifact_client_calls (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    turn_id UUID NOT NULL, call_id TEXT NOT NULL,
    client_id UUID NOT NULL, input JSONB NOT NULL, result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id, turn_id, call_id)
  )`.simple();
  await sql`ALTER TABLE assistant.artifact_client_calls ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.artifact_projects (
    artifact_id UUID NOT NULL REFERENCES assistant.artifacts(id) ON DELETE CASCADE,
    project_id UUID NOT NULL,
    PRIMARY KEY(artifact_id,project_id)
  )`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.artifact_storage (
    artifact_id UUID NOT NULL REFERENCES assistant.artifacts(id) ON DELETE CASCADE,
    area TEXT NOT NULL CHECK(area IN ('kv','files')),
    key TEXT NOT NULL, content TEXT NOT NULL, media_type TEXT NOT NULL DEFAULT '',
    bytes BIGINT NOT NULL CHECK(bytes >= 0), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(artifact_id,area,key)
  )`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.artifact_databases (
    artifact_id UUID PRIMARY KEY REFERENCES assistant.artifacts(id) ON DELETE CASCADE,
    namespace TEXT NOT NULL UNIQUE, connected BOOLEAN NOT NULL DEFAULT false
  )`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.database_cleanup (
    namespace TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.capability_calls (
    id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    artifact_id UUID REFERENCES assistant.artifacts(id) ON DELETE CASCADE, conversation_id TEXT,
    request JSONB NOT NULL, prepared JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.http_secrets (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL, name TEXT NOT NULL,
    resource_id UUID REFERENCES assistant.artifacts(id) ON DELETE CASCADE,
    origin TEXT NOT NULL, header TEXT NOT NULL, prefix TEXT NOT NULL,
    encrypted TEXT NOT NULL, revision UUID NOT NULL,
    PRIMARY KEY(user_id,scope,name)
  )`.simple();
  await sql`CREATE TABLE IF NOT EXISTS assistant.http_calls (
    id UUID NOT NULL, user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    hash TEXT NOT NULL, encrypted TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(user_id,id)
  )`.simple();
  await sql`CREATE INDEX IF NOT EXISTS assistant_http_calls_created ON assistant.http_calls(created_at)`.simple();
  // Project membership is checked through the public AI project service.
  // No conversation foreign key owns an artifact. Chat references are ordinary URLs.
}
