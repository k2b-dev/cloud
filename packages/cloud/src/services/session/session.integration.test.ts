import { describe, expect, spyOn, test } from "bun:test";
import { redis, sql } from "bun";
import { migrateBrowserSessionCutover } from "../../../../core/src/migrate/core/auth";
import { session } from "./index";
import { createTestSession } from "./test-fixture";

// Changes the migration marker: never run against a developer or live database.
const isolated = /\/cloud_oauth_verify_[a-z0-9_]+(?:\?|$)/.test(process.env.DATABASE_URL ?? "");
const suite = isolated ? describe : describe.skip;
const fixture = async () => {
  const userId = crypto.randomUUID();
  await sql`INSERT INTO auth.users (id, uid, provider, profile)
    VALUES (${userId}, ${`jwt-session-${userId}`}, 'local', 'user')`;
  return { userId, create: () => createTestSession(userId), cleanup: () => sql`DELETE FROM auth.users WHERE id = ${userId}::uuid` };
};

suite("JWT-only browser sessions", () => {
  test("rejects opaque sessions without accessing their existing Redis records", async () => {
    const f = await fixture();
    const token = `${f.userId}:${crypto.randomUUID()}`;
    await redis.set(`session:${token}`, JSON.stringify({ userId: f.userId, gen: 7 }), "EX", 60);
    const get = spyOn(redis, "get").mockRejectedValue(new Error("Redis must not be read"));
    const del = spyOn(redis, "del").mockRejectedValue(new Error("Redis must not be written"));
    try {
      expect(await session.authenticate(token)).toBeNull();
      await session.revoke(token);
      expect(get).not.toHaveBeenCalled();
      expect(del).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      del.mockRestore();
      await redis.del(`session:${token}`);
      await f.cleanup();
    }
  });

  test("revokes only the selected family and supports re-login", async () => {
    const f = await fixture();
    try {
      const first = await f.create();
      const second = await f.create();
      expect((await session.authenticate(first))?.user.id).toBe(f.userId);
      await session.revoke(first);
      expect(await session.authenticate(first)).toBeNull();
      expect((await session.authenticate(second))?.user.id).toBe(f.userId);
      expect((await session.authenticate(await f.create()))?.user.id).toBe(f.userId);
    } finally {
      await f.cleanup();
    }
  });

  test("concurrent revoke-all is durable without Redis and new sessions use the current epoch", async () => {
    const f = await fixture();
    try {
      const old = await f.create();
      expect((await session.authenticate(old))?.data.authEpoch).toBe(0);
      const get = spyOn(redis, "get").mockRejectedValue(new Error("Redis unavailable"));
      const send = spyOn(redis, "send").mockRejectedValue(new Error("Redis unavailable"));
      try {
        await Promise.all([session.revokeAllForUser(f.userId), session.revokeAllForUser(f.userId)]);
        expect(await session.authenticate(old)).toBeNull();
        expect(get).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
      } finally {
        get.mockRestore();
        send.mockRestore();
      }
      expect((await session.authenticate(await f.create()))?.data.authEpoch).toBe(2);
    } finally {
      await f.cleanup();
    }
  });

  test("consumes the cutover once across concurrent migrations without changing user authority", async () => {
    const f = await fixture();
    try {
      await sql`ALTER TABLE auth.users ADD COLUMN legacy_session_generation bigint NOT NULL DEFAULT 0`;
      const previous = await f.create();
      // Do not prepare a user.* projection against the temporary old schema:
      // real upgrades drain those connections before running the migration.
      const [before] = await sql<{ active: number }[]>`SELECT count(*)::int AS active
        FROM auth.session_families WHERE user_id = ${f.userId} AND revoked_at IS NULL`;
      expect(before?.active).toBe(1);
      await Promise.all([migrateBrowserSessionCutover(), migrateBrowserSessionCutover()]);
      expect(await session.authenticate(previous)).toBeNull();
      const [user] = await sql<{ epoch: number }[]>`SELECT auth_epoch::int AS epoch FROM auth.users WHERE id = ${f.userId}`;
      expect(user?.epoch).toBe(0);
      const current = await f.create();
      await migrateBrowserSessionCutover();
      expect((await session.authenticate(current))?.user.id).toBe(f.userId);
      const [marker] = await sql<{ present: boolean }[]>`SELECT EXISTS (
        SELECT 1 FROM pg_attribute WHERE attrelid = 'auth.users'::regclass
          AND attname = 'legacy_session_generation' AND NOT attisdropped
      ) AS present`;
      expect(marker?.present).toBeFalse();
    } finally {
      await f.cleanup();
    }
  });

  test("rejects deleted and expired users behind signed sessions", async () => {
    const f = await fixture();
    try {
      const token = await f.create();
      await sql`UPDATE auth.users SET account_expires = now() - interval '1 day' WHERE id = ${f.userId}`;
      expect(await session.authenticate(token)).toBeNull();
      await sql`UPDATE auth.users SET account_expires = NULL WHERE id = ${f.userId}`;
      expect(await session.authenticate(token)).toBeNull();
      const current = await f.create();
      await f.cleanup();
      expect(await session.authenticate(current)).toBeNull();
    } finally {
      await f.cleanup();
    }
  });
});
