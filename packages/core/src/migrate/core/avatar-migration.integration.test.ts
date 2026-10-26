import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { migrateBuiltAvatars } from "./auth";

const suite = databaseSuite();
const PHOTO = "data:image/png;base64,iVBORw0KGgo=";
const HASH = "c".repeat(64);

suite("Core built-avatar migration", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    database = await useFreshDatabase("built_avatars");
    // The shape before built avatars: a photo with its hash, tied by the photo-only check.
    await sql`CREATE SCHEMA auth`.simple();
    await sql`
      CREATE TABLE auth.users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        avatar_data_url TEXT,
        avatar_hash TEXT,
        CONSTRAINT users_avatar_hash_check CHECK (
          (avatar_data_url IS NULL AND avatar_hash IS NULL)
          OR (avatar_data_url IS NOT NULL AND avatar_hash IS NOT NULL AND avatar_hash ~ '^[a-f0-9]{64}$')
        )
      )
    `.simple();
    await sql`CREATE TABLE auth.service_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL)`.simple();
  });
  afterAll(async () => {
    await database?.drop();
  });

  test("concurrent upgrades keep old rows valid and enforce the new avatar states", async () => {
    const [photo] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users (avatar_data_url, avatar_hash) VALUES (${PHOTO}, ${HASH}) RETURNING id`;
    const [plain] = await sql<{ id: string }[]>`INSERT INTO auth.users DEFAULT VALUES RETURNING id`;
    const [agent] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name) VALUES ('Robot') RETURNING id`;

    await Promise.all(Array.from({ length: 4 }, () => migrateBuiltAvatars()));
    await migrateBuiltAvatars();

    const constraints = await sql<{ conname: string; convalidated: boolean }[]>`
      SELECT conname, convalidated FROM pg_constraint
      WHERE conrelid IN ('auth.users'::regclass, 'auth.service_accounts'::regclass) AND conname LIKE '%avatar%'
      ORDER BY conname
    `;
    expect(constraints).toEqual([
      { conname: "service_accounts_avatar_config_check", convalidated: true },
      { conname: "service_accounts_avatar_data_url_check", convalidated: true },
      { conname: "service_accounts_avatar_kind_check", convalidated: true },
      { conname: "service_accounts_avatar_state_check", convalidated: true },
      { conname: "users_avatar_config_check", convalidated: true },
      { conname: "users_avatar_kind_check", convalidated: true },
      { conname: "users_avatar_state_check", convalidated: true },
    ]);

    const rows = await sql<{ id: string; avatar_kind: string | null; avatar_hash: string | null }[]>`
      SELECT id, avatar_kind, avatar_hash FROM auth.users ORDER BY avatar_hash NULLS LAST
    `;
    expect(rows).toEqual([
      { id: photo!.id, avatar_kind: null, avatar_hash: HASH },
      { id: plain!.id, avatar_kind: null, avatar_hash: null },
    ]);

    const attempt = async (write: () => Promise<unknown>) => {
      try {
        await write();
        return "stored";
      } catch (error) {
        return (error as { constraint?: string }).constraint;
      }
    };
    const config = JSON.stringify({ v: 1, kind: "person" });
    expect(await attempt(() => sql`UPDATE auth.users SET avatar_kind = 'built', avatar_hash = ${HASH} WHERE id = ${plain!.id}::uuid`)).toBe(
      "users_avatar_state_check",
    );
    expect(
      await attempt(
        () =>
          sql`UPDATE auth.users SET avatar_kind = 'built', avatar_config = ${config}::text::jsonb, avatar_hash = ${HASH} WHERE id = ${plain!.id}::uuid`,
      ),
    ).toBe("stored");
    // A person's photo stays stored while the built avatar shows.
    expect(
      await attempt(
        () =>
          sql`UPDATE auth.users SET avatar_kind = 'built', avatar_config = ${config}::text::jsonb, avatar_hash = ${HASH} WHERE id = ${photo!.id}::uuid`,
      ),
    ).toBe("stored");
    expect(await attempt(() => sql`UPDATE auth.users SET avatar_kind = 'initials' WHERE id = ${photo!.id}::uuid`)).toBe(
      "users_avatar_state_check",
    );
    expect(
      await attempt(
        () => sql`UPDATE auth.users SET avatar_config = ${JSON.stringify("x".repeat(2_000))}::text::jsonb WHERE id = ${plain!.id}::uuid`,
      ),
    ).toBe("users_avatar_config_check");
    expect(await attempt(() => sql`UPDATE auth.service_accounts SET avatar_hash = ${HASH} WHERE id = ${agent!.id}::uuid`)).toBe(
      "service_accounts_avatar_state_check",
    );
    expect(await attempt(() => sql`UPDATE auth.service_accounts SET avatar_kind = 'photo' WHERE id = ${agent!.id}::uuid`)).toBe(
      "service_accounts_avatar_state_check",
    );
  });
});
