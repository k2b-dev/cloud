import { sql } from "bun";
export async function migrateTemplates() {
  await sql`CREATE TABLE IF NOT EXISTS filesv2.templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL, bytes BYTEA NOT NULL, size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 20971520),
    created_by UUID NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.simple();
  await sql`CREATE TABLE IF NOT EXISTS filesv2.template_access (
    template_id UUID NOT NULL REFERENCES filesv2.templates(id) ON DELETE CASCADE,
    access_id UUID NOT NULL REFERENCES auth.access(id) ON DELETE CASCADE,
    PRIMARY KEY(template_id, access_id)
  )`.simple();
}
