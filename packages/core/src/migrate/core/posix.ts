import { sql } from "bun";

/** Additive schema only: provisioning existing local accounts is an explicit admin action. */
export const migratePosix = async (db: typeof sql = sql): Promise<void> => {
  await db`
    CREATE TABLE IF NOT EXISTS auth.user_posix (
      user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
      managed_by TEXT NOT NULL CHECK (managed_by IN ('local', 'ipa')),
      uid_number INTEGER,
      primary_gid_number INTEGER,
      primary_group_id UUID REFERENCES auth.groups(id) ON DELETE RESTRICT,
      home_directory TEXT,
      login_shell TEXT,
      CONSTRAINT local_posix_complete CHECK (managed_by <> 'local' OR (
        uid_number > 0 AND uid_number IS NOT NULL AND primary_gid_number > 0 AND primary_gid_number IS NOT NULL
        AND primary_group_id IS NOT NULL AND home_directory IS NOT NULL AND login_shell IS NOT NULL
      ))
    )
  `.simple();
  await db`CREATE INDEX IF NOT EXISTS user_posix_uid_number ON auth.user_posix(uid_number)`.simple();
  await db`CREATE INDEX IF NOT EXISTS user_posix_primary_gid ON auth.user_posix(primary_gid_number)`.simple();
  await db`CREATE INDEX IF NOT EXISTS groups_gid_number ON auth.groups(gid_number) WHERE gid_number IS NOT NULL`.simple();
  // No foreign key on owner_id: deletion must not make an allocated ID reusable.
  await db`
    CREATE TABLE IF NOT EXISTS auth.posix_allocations (
      kind TEXT NOT NULL CHECK (kind IN ('uid', 'gid')),
      number INTEGER NOT NULL CHECK (number > 0),
      owner_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (kind, number),
      UNIQUE (kind, owner_id)
    )
  `.simple();
};
