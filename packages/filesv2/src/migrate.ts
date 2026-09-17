import { sql } from "bun";

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
}
