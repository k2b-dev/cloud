import { sql } from "bun";

/** Provisioning existing local accounts remains an explicit admin action. */
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
  // Group lists join each group's personal-group owner through this column.
  await db`CREATE INDEX IF NOT EXISTS user_posix_primary_group ON auth.user_posix(primary_group_id) WHERE primary_group_id IS NOT NULL`.simple();
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
  await migratePersonalGroups(db);
};

/** Durable ownership has no account/group foreign keys: retirement must preserve it. */
const migratePersonalGroups = async (db: typeof sql): Promise<void> => {
  await db.begin(async (tx) => {
    // Serialize installation/backfill with provisioning and every account deletion path.
    await tx`LOCK TABLE auth.users, auth.groups, auth.user_posix IN SHARE ROW EXCLUSIVE MODE`;
    await tx`
      CREATE TABLE IF NOT EXISTS auth.personal_groups (
        group_id UUID PRIMARY KEY,
        owner_id UUID NOT NULL,
        group_name TEXT NOT NULL,
        gid_number INTEGER NOT NULL CHECK (gid_number > 0),
        retired_at TIMESTAMPTZ
      )
    `.simple();
    await tx`CREATE INDEX IF NOT EXISTS personal_groups_owner ON auth.personal_groups(owner_id)`.simple();
    const [ambiguous] = await tx`SELECT primary_group_id FROM auth.user_posix
      WHERE managed_by = 'local' GROUP BY primary_group_id HAVING count(*) > 1 LIMIT 1`;
    if (ambiguous) throw new Error(`Personal Linux group ${ambiguous.primary_group_id} has multiple owners; operator review is required.`);
    await tx`
      INSERT INTO auth.personal_groups(group_id, owner_id, group_name, gid_number)
      SELECT p.primary_group_id, p.user_id, g.name, p.primary_gid_number
      FROM auth.user_posix p JOIN auth.groups g ON g.id = p.primary_group_id
      WHERE p.managed_by = 'local' AND g.provider = 'local'
      ON CONFLICT (group_id) DO NOTHING
    `;
    await tx`
      CREATE OR REPLACE FUNCTION auth.remember_personal_group() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.managed_by = 'local' THEN
          INSERT INTO auth.personal_groups(group_id, owner_id, group_name, gid_number)
          SELECT NEW.primary_group_id, NEW.user_id, g.name, NEW.primary_gid_number
          FROM auth.groups g WHERE g.id = NEW.primary_group_id
          ON CONFLICT (group_id) DO NOTHING;
          IF NOT EXISTS (
            SELECT 1 FROM auth.personal_groups WHERE group_id = NEW.primary_group_id
              AND owner_id = NEW.user_id AND gid_number = NEW.primary_gid_number AND retired_at IS NULL
          ) THEN
            RAISE EXCEPTION 'Personal group ownership cannot be reassigned' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END $$
    `.simple();
    await tx`CREATE OR REPLACE TRIGGER remember_personal_group
      AFTER INSERT OR UPDATE ON auth.user_posix FOR EACH ROW EXECUTE FUNCTION auth.remember_personal_group()`.simple();
    await tx`
      CREATE OR REPLACE FUNCTION auth.retire_personal_groups() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        -- Remove the retiring account's primary-group restriction regardless of FK trigger order.
        DELETE FROM auth.user_posix WHERE user_id = OLD.id;
        UPDATE auth.personal_groups SET retired_at = COALESCE(retired_at, now()) WHERE owner_id = OLD.id;
        -- Existing FKs remove memberships, nesting, managers, directory/app grants and access junctions.
        -- A restrictive application FK fails the whole account deletion, never a partial retirement.
        DELETE FROM auth.groups WHERE id IN (SELECT group_id FROM auth.personal_groups WHERE owner_id = OLD.id);
        RETURN OLD;
      END $$
    `.simple();
    await tx`CREATE OR REPLACE TRIGGER retire_personal_groups
      AFTER DELETE ON auth.users FOR EACH ROW EXECUTE FUNCTION auth.retire_personal_groups()`.simple();
  });
};
