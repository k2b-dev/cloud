import { sql } from "bun";

export async function migrateMachineStorage() {
  // Keep ownership after account deletion, as with human base claims.
  await sql`CREATE TABLE IF NOT EXISTS filesv2.machine_storage (
    base_id uuid PRIMARY KEY REFERENCES filesv2.bases(id), owner_id uuid NOT NULL UNIQUE,
    owner_kind text NOT NULL CHECK(owner_kind IN ('agent','standalone')), owner_name text NOT NULL, server_url text NOT NULL
  )`.simple();
  await sql`CREATE TABLE IF NOT EXISTS filesv2.storage_access (
    base_id uuid NOT NULL REFERENCES filesv2.bases(id), path text NOT NULL,
    access_id uuid PRIMARY KEY REFERENCES auth.access(id) ON DELETE CASCADE
  )`.simple();
  await sql`CREATE INDEX IF NOT EXISTS filesv2_storage_grants ON filesv2.storage_access(base_id)`.simple();
  await sql`CREATE TABLE IF NOT EXISTS filesv2.transfer_tickets (
    digest text PRIMARY KEY, base_id uuid NOT NULL REFERENCES filesv2.bases(id),
    principal_id uuid NOT NULL, principal_kind text NOT NULL CHECK(principal_kind IN ('user','service_account')), delegated_user_id uuid, credential_id uuid, credential_expires_at timestamptz, scopes text[] NOT NULL,
    path text NOT NULL, permission text NOT NULL CHECK(permission IN ('read','write')),
    share_id uuid, payload text NOT NULL, expires_at timestamptz NOT NULL
  )`.simple();
  await sql`CREATE INDEX IF NOT EXISTS filesv2_transfer_expiry ON filesv2.transfer_tickets(expires_at)`.simple();
  await sql`ALTER TABLE filesv2.activity DROP CONSTRAINT IF EXISTS activity_actor_kind_check,
    ADD CONSTRAINT activity_actor_kind_check CHECK(actor_kind IN ('user','service_account','visitor','system','observed'))`.simple();
  await sql`ALTER TABLE filesv2.activity ADD COLUMN IF NOT EXISTS actor_service_account_id uuid`.simple();
  await sql`ALTER TABLE filesv2.shares ADD COLUMN IF NOT EXISTS created_by_machine_kind text CHECK(created_by_machine_kind IN ('agent','standalone'))`.simple();
  await sql`ALTER TABLE filesv2.shares ADD COLUMN IF NOT EXISTS created_by_kind text NOT NULL DEFAULT 'user' CHECK(created_by_kind IN ('user','service_account'))`.simple();
}
export const machineStorage = {
  async owner(baseId: string): Promise<string | null> {
    const [row] = await sql<{ owner_id: string }[]>`SELECT owner_id FROM filesv2.machine_storage WHERE base_id=${baseId}::uuid`;
    return row?.owner_id ?? null;
  },
  async server(baseId: string): Promise<string | null> {
    const [row] = await sql<{ server_url: string }[]>`SELECT server_url FROM filesv2.machine_storage WHERE base_id=${baseId}::uuid`;
    return row?.server_url ?? null;
  },
};
