import { expect, setSystemTime, spyOn, test } from "bun:test";
import { redis, sql } from "bun";
import { Hono } from "hono";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import { migrateBrowserSessionCutover } from "../../../../core/src/migrate/core/auth";
import { IDENTITY_CLOCK_TOLERANCE_SECONDS, IDENTITY_ROLLOUT_MARGIN_MS } from "../identity/constants";
import * as settings from "../settings";
import { SessionEpochChangedError, session } from "./index";
import { createTestSession } from "./session.test-fixture";

const withFrozenTime = async (run: () => Promise<void>) => {
  const [clock] = await sql<{ now: Date }[]>`SELECT now() AS now`;
  setSystemTime(clock!.now);
  try {
    await run();
  } finally {
    setSystemTime();
  }
};

// Changes the migration marker: never run against a developer or live database.
const suite = databaseSuite();
const fixture = async () => {
  const userId = crypto.randomUUID();
  await sql`INSERT INTO auth.users (id, uid, provider, profile)
    VALUES (${userId}, ${`jwt-session-${userId}`}, 'local', 'user')`;
  return { userId, create: () => createTestSession(userId), cleanup: () => sql`DELETE FROM auth.users WHERE id = ${userId}::uuid` };
};

suite("JWT-only browser sessions", () => {
  test("refuses session creation after the approved epoch changes", () =>
    withFrozenTime(async () => {
      const f = await fixture();
      try {
        const [user] = await sql<{ auth_epoch: string | number }[]>`SELECT auth_epoch FROM auth.users WHERE id = ${f.userId}::uuid`;
        const authEpoch = Number(user!.auth_epoch);
        await session.revokeAllForUser(f.userId);
        let rejected: unknown;
        const routes = new Hono().post("/login", async (c) => {
          try {
            await session.create(c, f.userId, { method: "cloud_login", notify: null, authEpoch });
            return c.body(null, 204);
          } catch (error) {
            rejected = error;
            return c.body(null, 409);
          }
        });
        const response = await routes.request("/login", { method: "POST" });
        expect(response.status).toBe(409);
        expect(rejected).toBeInstanceOf(SessionEpochChangedError);
        expect(response.headers.has("set-cookie")).toBe(false);
        expect(await sql`SELECT sid FROM auth.session_families WHERE user_id = ${f.userId}::uuid`).toHaveLength(0);
      } finally {
        await f.cleanup();
      }
    }));

  test("retains signing keys atomically for concurrent long sessions without maintenance", async () => {
    const first = await fixture();
    const second = await fixture();
    const originalExpiry = await settings.get<number>("user.session.expiry_hours");
    try {
      await settings.set("user.session.expiry_hours", 90 * 24);
      await Promise.all([first.create(), second.create()]);
      const rows = await sql<Array<{ retained: boolean }>>`
        SELECT sk.verify_until >= sf.expires_at
          + (${IDENTITY_CLOCK_TOLERANCE_SECONDS}::int * INTERVAL '1 second')
          + (${IDENTITY_ROLLOUT_MARGIN_MS}::int * INTERVAL '1 millisecond') AS retained
        FROM auth.session_families sf JOIN auth.signing_keys sk ON sk.kid = sf.signing_kid
        WHERE sf.user_id IN (${first.userId}::uuid, ${second.userId}::uuid)
      `;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.retained)).toBeTrue();
    } finally {
      await settings.set("user.session.expiry_hours", originalExpiry);
      await first.cleanup();
      await second.cleanup();
    }
  });

  test("account-bound logout refuses replacement credentials and revokes without a cookie mutation", async () => {
    const rendered = await fixture();
    const current = await fixture();
    try {
      const token = await current.create();
      const routes = new Hono().post("/logout", async (c) => {
        const deleted = await session.delete(c, c.req.header("expected-user") ?? null);
        return c.body(null, deleted ? 204 : 409);
      });
      const headers = { Cookie: `session_token=${token}`, "expected-user": rendered.userId };
      const changed = await routes.request("/logout", { method: "POST", headers });
      expect(changed.status).toBe(409);
      expect(changed.headers.has("set-cookie")).toBe(false);
      expect((await session.authenticate(token))?.user.id).toBe(current.userId);
      const anonymous = await routes.request("/logout", { method: "POST", headers: { Cookie: headers.Cookie } });
      expect(anonymous.status).toBe(409);
      const matching = await routes.request("/logout", { method: "POST", headers: { ...headers, "expected-user": current.userId } });
      expect(matching.status).toBe(204);
      expect(matching.headers.has("set-cookie")).toBe(false);
      expect(await session.authenticate(token)).toBeNull();
      expect((await routes.request("/logout", { method: "POST", headers: { "expected-user": current.userId } })).status).toBe(204);
    } finally {
      await rendered.cleanup();
      await current.cleanup();
    }
  });

  test("a delayed bound logout response preserves a newer browser sign-in", async () => {
    const first = await fixture();
    const next = await fixture();
    try {
      const firstToken = await first.create();
      let release!: () => void;
      let revoked!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        revoked = resolve;
      });
      const routes = new Hono().post("/logout", async (c) => {
        await session.delete(c, first.userId);
        revoked();
        await hold;
        return c.body(null, 204);
      });
      const response = routes.request("/logout", { method: "POST", headers: { Cookie: `session_token=${firstToken}` } });
      await ready;
      try {
        const nextToken = await next.create();
        release();
        expect((await response).headers.has("set-cookie")).toBe(false);
        expect(await session.authenticate(firstToken)).toBeNull();
        expect((await session.authenticate(nextToken))?.user.id).toBe(next.userId);
      } finally {
        release();
        await response;
      }
      const unbound = new Hono().post("/logout", async (c) => {
        await session.delete(c);
        return c.body(null, 204);
      });
      expect((await unbound.request("/logout", { method: "POST" })).headers.get("set-cookie")).toContain("session_token=");
    } finally {
      await first.cleanup();
      await next.cleanup();
    }
  });

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
