import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { listDuplicateEmails } from "./duplicate-emails";

// Minimal schema in a dedicated disposable database; never touch the development database.
const isolated = /\/cloud_duplicate_accounts_test(?:\?|$)/.test(process.env.DATABASE_URL ?? "");
const admin = { userId: "admin", uid: "admin", roles: ["admin"] };

test("duplicate email reads reject non-administrators before database access", async () => {
  const result = await listDuplicateEmails({ actor: { ...admin, roles: ["user"] } });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toBe("Admin access required");
});

(isolated ? describe : describe.skip)("duplicate email groups in Postgres", () => {
  beforeAll(async () => {
    await sql`CREATE SCHEMA auth`;
    await sql`CREATE TABLE auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), uid text NOT NULL, provider text NOT NULL,
      profile text NOT NULL DEFAULT 'user', given_name text NOT NULL DEFAULT '', sn text NOT NULL DEFAULT '',
      display_name text NOT NULL DEFAULT '', mail text, account_expires timestamptz, last_login_local timestamptz
    )`;
    await sql`CREATE TABLE auth.user_ipa_data (user_id uuid PRIMARY KEY REFERENCES auth.users(id), last_login_ipa timestamptz, synced_at timestamptz)`;
    await sql`INSERT INTO auth.users (uid, provider, mail, last_login_local) VALUES
      ('alpha-ipa', 'ipa', 'Alpha@example.com', '2026-09-08T10:00:00Z'),
      ('alpha-guest', 'local', ' alpha@example.com ', '2026-08-01T12:00:00Z'),
      ('alpha-local', 'local', 'ALPHA@example.com', NULL),
      ('beta-ipa', 'ipa', 'beta@example.com', NULL), ('beta-local', 'local', 'beta@example.com', NULL),
      ('single', 'local', 'single@example.com', NULL),
      ('empty1', 'local', '', NULL), ('empty2', 'ipa', ' ', NULL), ('null1', 'local', NULL, NULL), ('null2', 'ipa', NULL, NULL)`;
    await sql`INSERT INTO auth.user_ipa_data (user_id, last_login_ipa, synced_at)
      SELECT id, '2026-09-07T09:00:00Z', '2026-09-08T09:00:00Z' FROM auth.users WHERE uid = 'alpha-ipa'`;
  });
  afterAll(async () => {
    await sql`DROP SCHEMA auth CASCADE`;
  });

  test("normalizes addresses, excludes empty and unique addresses and keeps all three matches on one page", async () => {
    const result = await listDuplicateEmails({ actor: admin, pagination: { page: 1, perPage: 1 } });
    if (!result.ok) throw result.error;
    expect(result.data).toMatchObject({ total: 2, page: 1, perPage: 1, hasNext: true });
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]!.email).toBe("alpha@example.com");
    expect(result.data.items[0]!.users).toHaveLength(3);
    expect(result.data.items[0]!.users.find((user) => user.uid === "alpha-ipa")).toMatchObject({
      lastLoginLocal: "2026-09-08T10:00:00.000Z",
      lastLoginIpa: "2026-09-07T09:00:00.000Z",
      ipaSyncedAt: "2026-09-08T09:00:00.000Z",
    });
    expect(result.data.items[0]!.users.find((user) => user.uid === "alpha-local")).toMatchObject({
      lastLoginLocal: null,
      lastLoginIpa: null,
    });
    const next = await listDuplicateEmails({ actor: admin, pagination: { page: 2, perPage: 1 } });
    if (!next.ok) throw next.error;
    expect(next.data.items[0]!.email).toBe("beta@example.com");
    expect(next.data.items[0]!.users).toHaveLength(2);
    expect(next.data.hasNext).toBe(false);
  });

  test("clamps an out-of-range page, removes resolved groups and returns an empty first page", async () => {
    await sql`DELETE FROM auth.users WHERE uid = 'beta-local'`;
    const result = await listDuplicateEmails({ actor: admin, pagination: { page: 2, perPage: 1 } });
    if (!result.ok) throw result.error;
    expect(result.data).toMatchObject({ page: 1, total: 1, hasNext: false });
    await sql`DELETE FROM auth.users WHERE provider = 'local'`;
    const empty = await listDuplicateEmails({ actor: admin, pagination: { page: 2, perPage: 1 } });
    if (!empty.ok) throw empty.error;
    expect(empty.data).toMatchObject({ page: 1, total: 0, items: [], hasNext: false });
  });
});
