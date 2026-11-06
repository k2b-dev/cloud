import { sql } from "@k2b/cloud";

export const migrate = async (): Promise<void> => {
  await sql`CREATE SCHEMA IF NOT EXISTS announcements`.simple();
  console.log("  ✓ announcements schema");

  await sql`
    CREATE SEQUENCE IF NOT EXISTS announcements.version_seq
  `.simple();
  console.log("  ✓ announcements.version_seq sequence");

  await sql`
    CREATE TABLE IF NOT EXISTS announcements.entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      version INTEGER NOT NULL DEFAULT nextval('announcements.version_seq'),
      kind TEXT NOT NULL CHECK (kind IN ('announcement', 'banner')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tone TEXT NOT NULL DEFAULT 'info' CHECK (tone IN ('info', 'success', 'warning', 'danger')),
      published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT announcements_entries_version_unique UNIQUE (version),
      CONSTRAINT announcements_entries_expiry_check CHECK (expires_at IS NULL OR expires_at > published_at)
    )
  `.simple();
  console.log("  ✓ announcements.entries table");

  await sql`
    CREATE INDEX IF NOT EXISTS announcements_entries_active_idx
    ON announcements.entries(kind, published_at, expires_at)
  `.simple();
  console.log("  ✓ announcements.entries active index");
};
