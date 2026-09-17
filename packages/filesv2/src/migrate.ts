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
}
