import { sql } from "bun";
import { migrateSharing } from "./data/sharing-migration";
import { migrateTemplates } from "./data/templates";
import { migrateTrash } from "./migrate-trash";

export async function migrate(): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS filesv2`.simple();
  // No identity FK: deletion must retain the old claim and prevent name reuse.
  await sql`CREATE TABLE IF NOT EXISTS filesv2.bases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    area TEXT NOT NULL CHECK (area IN ('cloud','freeipa')),
    kind TEXT NOT NULL CHECK (kind IN ('users','groups')),
    identity_id UUID NOT NULL,
    identity_name TEXT NOT NULL,
    root TEXT NOT NULL,
    path TEXT NOT NULL,
    uid_number BIGINT,
    gid_number BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(root,path),
    UNIQUE(area,kind,identity_id)
  )`.simple();
  await sql`ALTER TABLE filesv2.bases ADD COLUMN IF NOT EXISTS lifecycle TEXT NOT NULL DEFAULT 'active'`.simple();
  await sql`CREATE TABLE IF NOT EXISTS filesv2.operations (
    id UUID PRIMARY KEY,
    area TEXT NOT NULL,
    kind TEXT NOT NULL,
    root TEXT NOT NULL,
    server_url TEXT NOT NULL,
    name TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create','archive','restore','delete')),
    source TEXT NOT NULL,
    target TEXT,
    base_id UUID REFERENCES filesv2.bases(id),
    archive_id UUID,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','complete','restored','deleted')),
    actor_id UUID,
    actor_name TEXT,
    snapshot JSONB,
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.simple();
  await sql`ALTER TABLE filesv2.operations ADD COLUMN IF NOT EXISTS server_url TEXT NOT NULL DEFAULT ''`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS filesv2_pending_operation ON filesv2.operations(root,source) WHERE state='pending'`.simple();
  await sql`CREATE TABLE IF NOT EXISTS filesv2.maintenance (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
    after_id UUID
  )`.simple();
  await sql`CREATE INDEX IF NOT EXISTS filesv2_archive_inventory ON filesv2.operations(area,root,id) WHERE action='archive' AND state IN ('pending','complete')`.simple();
  await sql`CREATE INDEX IF NOT EXISTS filesv2_pending_recovery ON filesv2.operations(updated_at,id) WHERE state='pending'`.simple();
  // Upload sessions live in Filegate; this row binds one session to the user and target that opened it.
  await sql`CREATE TABLE IF NOT EXISTS filesv2.uploads (
    id TEXT PRIMARY KEY,
    base_id UUID NOT NULL REFERENCES filesv2.bases(id),
    user_id UUID NOT NULL,
    root TEXT NOT NULL,
    path TEXT NOT NULL,
    size BIGINT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','committed','aborted')),
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.simple();
  // User deletions move entries into the reserved trash folder; the row remembers where they came from.
  await sql`CREATE TABLE IF NOT EXISTS filesv2.trash (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    base_id UUID NOT NULL REFERENCES filesv2.bases(id),
    user_id UUID NOT NULL,
    root TEXT NOT NULL,
    original TEXT NOT NULL,
    trashed TEXT NOT NULL,
    directory BOOLEAN NOT NULL,
    state TEXT NOT NULL DEFAULT 'trashed' CHECK (state IN ('trashed','restored','gone')),
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.simple();
  await sql`CREATE INDEX IF NOT EXISTS filesv2_trash_base ON filesv2.trash(base_id,deleted_at) WHERE state='trashed'`.simple();
  await sql`ALTER TABLE filesv2.uploads ADD COLUMN IF NOT EXISTS share_id UUID`.simple();
  // Public shares: a bundle of entries for download or a folder that accepts anonymous uploads. Both stay inside one base.
  await sql`CREATE TABLE IF NOT EXISTS filesv2.shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('download','inbox')),
    base_id UUID NOT NULL REFERENCES filesv2.bases(id),
    root TEXT NOT NULL,
    base_path TEXT NOT NULL,
    scope TEXT NOT NULL,
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    title TEXT NOT NULL,
    note TEXT,
    owner_uid INTEGER,
    owner_gid INTEGER,
    created_by UUID NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    revoked_by UUID,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TIMESTAMPTZ
  )`.simple();
  await sql`CREATE INDEX IF NOT EXISTS filesv2_shares_base ON filesv2.shares(base_id,created_at)`.simple();
  // Per-user pointers: recently opened entries and favorites. They name a binding so a reused path never leaks.
  for (const table of ["recent", "favorites"]) {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS filesv2.${table} (
      user_id UUID NOT NULL,
      base_id UUID NOT NULL REFERENCES filesv2.bases(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      directory BOOLEAN NOT NULL DEFAULT false,
      marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, base_id, path)
    )`);
  }
  await sql`ALTER TABLE filesv2.uploads ADD COLUMN IF NOT EXISTS expected_revision TEXT`.simple();
  await migrateTemplates();
  await migrateTrash();
  await migrateSharing();
  await sql`CREATE TABLE IF NOT EXISTS filesv2.entry_references(id TEXT PRIMARY KEY, base_id TEXT NOT NULL, path TEXT NOT NULL)`.simple();
}
