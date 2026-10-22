import { sql } from "bun";

export async function migrateActivity(): Promise<void> {
  const [extension] = await sql<{ exists: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_trgm')`;
  if (!extension?.exists) await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.simple();
  await sql`CREATE TABLE IF NOT EXISTS filesv2.activity (
    id uuid PRIMARY KEY,
    started_at timestamptz NOT NULL DEFAULT now(),
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    next_check_at timestamptz NOT NULL DEFAULT now() + interval '60 seconds',
    checks int NOT NULL DEFAULT 0,
    state text NOT NULL CHECK (state IN ('pending','done','failed','not_done','unclear')),
    action text NOT NULL,
    server_url text NOT NULL,
    root text NOT NULL, root_after text,
    -- No binding FK: history must survive binding deletion.
    base_id uuid, base_after_id uuid,
    item_id text, item_after_id text,
    directory boolean NOT NULL,
    name text NOT NULL,
    path_before text, path_after text,
    size bigint, revision_before text, revision_after text, version_id text,
    actor_kind text NOT NULL CHECK (actor_kind IN ('user','visitor','system','observed')),
    -- No actor CHECK: ON DELETE SET NULL must also work for user rows.
    actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    via text NOT NULL,
    calling_app text, origin text, invocation_id text, request_id text,
    batch_id uuid,
    upload_id uuid UNIQUE,
    trash_id uuid, operation_id uuid, share_id uuid,
    error_code text,
    detail jsonb NOT NULL DEFAULT '{}'
  )`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS filesv2_activity_operation ON filesv2.activity(operation_id) WHERE operation_id IS NOT NULL`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS filesv2_activity_trash_phase ON filesv2.activity(trash_id,action) WHERE trash_id IS NOT NULL AND action IN ('item.trash','item.restore')`.simple();
  await sql`CREATE INDEX IF NOT EXISTS filesv2_activity_base ON filesv2.activity(base_id, started_at DESC, id DESC)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS filesv2_activity_base_after ON filesv2.activity(base_after_id, started_at DESC) WHERE base_after_id IS NOT NULL`.simple();
  await sql`CREATE INDEX IF NOT EXISTS filesv2_activity_item ON filesv2.activity(item_id) WHERE item_id IS NOT NULL`.simple();
  await sql`CREATE INDEX IF NOT EXISTS filesv2_activity_item_after ON filesv2.activity(item_after_id) WHERE item_after_id IS NOT NULL`.simple();
  // Paths may reach 4096 characters, more than a B-tree entry holds (about 2.7 KB). The first 400 characters
  // (at most 1.6 KB, plus a root of at most 128 characters) still serve prefix lookups; a query repeats the
  // left(...) expression next to its condition on the full path.
  await sql`CREATE INDEX IF NOT EXISTS filesv2_activity_path_before ON filesv2.activity(root, left(path_before, 400) text_pattern_ops)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS filesv2_activity_path_after ON filesv2.activity(root, left(path_after, 400) text_pattern_ops)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS filesv2_activity_next_check ON filesv2.activity(next_check_at) WHERE state IN ('pending','unclear')`.simple();
  await sql`CREATE INDEX IF NOT EXISTS filesv2_activity_started ON filesv2.activity(started_at)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS filesv2_activity_name ON filesv2.activity USING gin (name gin_trgm_ops)`.simple();
}
