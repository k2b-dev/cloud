import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { redis, sql } from "bun";
import { Hono } from "hono";
import { session } from "./index";
import { LEGACY_SESSION_EPOCH_FLOOR, loadJwtSessionUser } from "./user";

const canUseServices = async (): Promise<boolean> => {
  try {
    const [row] = await sql<Array<{ users: string | null }>>`SELECT to_regclass('auth.users')::text AS users`;
    await redis.ping();
    return Boolean(row?.users);
  } catch {
    return false;
  }
};

const suite = (await canUseServices()) ? describe : describe.skip;
const userId = crypto.randomUUID();
const randomToken = crypto.randomUUID();
const token = `${userId}:${randomToken}`;
const sessionKey = `session:${userId}:${randomToken}`;
const generationKey = `session:gen:${userId}`;

suite("legacy session migration revocation", () => {
  beforeAll(async () => {
    await sql`
      INSERT INTO auth.users (id, uid, provider, profile, given_name, sn, display_name, mail)
      VALUES (
        ${userId}, ${`legacy-revoke-${userId}`}, 'local', 'user', 'Legacy', 'Revoke',
        'Legacy Revoke', ${`legacy-revoke-${userId}@example.test`}
      )
    `;
    await redis.set(generationKey, "7");
    await redis.set(sessionKey, JSON.stringify({ userId, gen: 7 }), "EX", 60);
  });

  afterAll(async () => {
    await Promise.allSettled([redis.del(sessionKey), redis.del(generationKey)]);
    await sql`DELETE FROM auth.users WHERE id = ${userId}`;
  });

  test("the PostgreSQL floor keeps opaque sessions revoked after Redis drift", async () => {
    expect((await session.authenticate(token))?.user.id).toBe(userId);

    await session.revokeAllForUser(userId);
    const [state] = await sql<Array<{ auth_epoch: string | number; legacy_session_generation: string | number }>>`
      SELECT auth_epoch, legacy_session_generation FROM auth.users WHERE id = ${userId}
    `;
    expect(Number(state!.auth_epoch)).toBe(1);
    expect(Number(state!.legacy_session_generation)).toBe(8);
    expect(Number(await redis.get(generationKey))).toBeGreaterThanOrEqual(8);
    expect(await session.authenticate(token)).toBeNull();

    await redis.set(generationKey, "7");
    expect(await session.authenticate(token)).toBeNull();
  });
});

const createFixture = async () => {
  const userId = crypto.randomUUID();
  const generationKey = `session:gen:${userId}`;
  const legacyToken = `${userId}:${crypto.randomUUID()}`;
  const keys = new Set([generationKey, `session:${legacyToken}`]);
  await sql`INSERT INTO auth.users (id, uid, provider, profile)
    VALUES (${userId}, ${`session-recovery-${userId}`}, 'local', 'user')`;
  await redis.set(generationKey, "7");
  await redis.set(`session:${legacyToken}`, JSON.stringify({ userId, gen: 7 }), "EX", 120);
  return {
    userId,
    generationKey,
    legacyToken,
    track: (token: string) => {
      keys.add(`session:${token}`);
      return token;
    },
    create: async () => {
      const token = await session.createDelegation(userId, 120);
      keys.add(`session:${token}`);
      return token;
    },
    cleanup: async () => {
      await Promise.all([...keys].map((key) => redis.del(key)));
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    },
  };
};
const storedSession = async (token: string): Promise<{ userId: string; gen: number; authEpoch?: number }> =>
  JSON.parse((await redis.get(`session:${token}`))!);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const waitForBlockedRevoke = async () => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const [row] = await sql<{ waiting: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
        AND wait_event_type = 'Lock' AND query LIKE '%SET auth_epoch = auth_epoch + 1%') AS waiting
    `;
    if (row?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error("Expected revoke-all to wait for legacy issuance's user lock");
};

suite("legacy epoch bridge recovery", () => {
  test("revokes JWTs durably through repeated Redis read failures and recovers without reviving old sessions", async () => {
    const fixture = await createFixture();
    const kid = crypto.randomUUID();
    const sid = crypto.randomUUID();
    const realGet = redis.get.bind(redis);
    const get = spyOn(redis, "get");
    try {
      await sql`INSERT INTO auth.signing_keys (purpose, state, kid, public_jwk, encrypted_private_jwk, encryption_key_id,
        activate_at, activated_at, sign_until, retired_at, verify_until)
        VALUES ('session', 'retired', ${kid}, '{}'::jsonb, 'test', 'test', now() - interval '2 days',
          now() - interval '2 days', now() - interval '1 day', now() - interval '1 day', now() + interval '1 day')`;
      await sql`INSERT INTO auth.session_families (sid, user_id, auth_epoch, signing_kid, expires_at)
        VALUES (${sid}::uuid, ${fixture.userId}::uuid, 0, ${kid}, now() + interval '1 hour')`;
      const jwtActor = { userId: fixture.userId, sid, authEpoch: 0, groupsAdmin: [] };
      expect((await loadJwtSessionUser(jwtActor))?.id).toBe(fixture.userId);
      get.mockImplementation((key) => (key === fixture.generationKey ? Promise.reject(new Error("Redis read unavailable")) : realGet(key)));
      await session.revokeAllForUser(fixture.userId);
      await session.revokeAllForUser(fixture.userId);
      expect(await loadJwtSessionUser(jwtActor)).toBeNull();
      get.mockRestore();
      const [state] = await sql<{ auth_epoch: number; floor: string }[]>`
        SELECT auth_epoch::int, legacy_session_generation::text AS floor FROM auth.users WHERE id = ${fixture.userId}::uuid
      `;
      expect(state).toEqual({ auth_epoch: 2, floor: String(LEGACY_SESSION_EPOCH_FLOOR) });
      const recovered = await fixture.create();
      const payload = await storedSession(recovered);
      expect(payload).toEqual({ userId: fixture.userId, gen: -1, authEpoch: 2 });
      expect(await redis.get(fixture.generationKey)).toBe("7");
      expect(payload.gen < Number(await redis.get(fixture.generationKey))).toBe(true); // Old reader fails closed.
      expect((await session.authenticate(recovered))?.user.id).toBe(fixture.userId);
      expect(await session.authenticate(fixture.legacyToken)).toBeNull();
      await session.revokeAllForUser(fixture.userId);
      expect(await session.authenticate(recovered)).toBeNull();
      const again = await fixture.create();
      expect((await session.authenticate(again))?.data.authEpoch).toBe(3);
      expect(await session.authenticate(fixture.legacyToken)).toBeNull();
    } finally {
      get.mockRestore();
      await fixture.cleanup();
      await sql`DELETE FROM auth.signing_keys WHERE kid = ${kid}`;
    }
  });

  test("reconciles a failed post-Postgres Redis sync before issuing a usable normal legacy session", async () => {
    const fixture = await createFixture();
    const realSend = redis.send.bind(redis);
    const send = spyOn(redis, "send").mockImplementation((command, args) =>
      command === "EVAL" && args.includes(fixture.generationKey)
        ? Promise.reject(new Error("Redis sync unavailable"))
        : realSend(command, args),
    );
    try {
      await session.revokeAllForUser(fixture.userId);
      expect(await redis.get(fixture.generationKey)).toBe("7");
      send.mockRestore();
      const recovered = await fixture.create();
      expect(await storedSession(recovered)).toEqual({ userId: fixture.userId, gen: 8, authEpoch: 1 });
      expect(await redis.get(fixture.generationKey)).toBe("8");
      expect((await session.authenticate(recovered))?.user.id).toBe(fixture.userId);
      await redis.set(fixture.generationKey, "7");
      expect(await session.authenticate(fixture.legacyToken)).toBeNull();
    } finally {
      send.mockRestore();
      await fixture.cleanup();
    }
  });

  test("recovers existing sentinel and overflow rows for browser login and delegation without raising Redis to MAX", async () => {
    const fixture = await createFixture();
    const originalMode = process.env.CLOUD_SESSION_ISSUANCE_MODE;
    try {
      process.env.CLOUD_SESSION_ISSUANCE_MODE = "legacy";
      await sql`UPDATE auth.users SET legacy_session_generation = ${String(BigInt(LEGACY_SESSION_EPOCH_FLOOR) + 5n)}::bigint
        WHERE id = ${fixture.userId}::uuid`;
      const route = new Hono().get("/", async (c) => c.json({ token: fixture.track(await session.create(c, fixture.userId)) }));
      const response = await route.request("/");
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
      const { token } = (await response.json()) as { token: string };
      expect((await session.authenticate(token))?.user.id).toBe(fixture.userId);
      expect(await redis.get(fixture.generationKey)).toBe("7");
      const impossibleOld = fixture.track(`${fixture.userId}:${crypto.randomUUID()}`);
      await redis.set(`session:${impossibleOld}`, JSON.stringify({ userId: fixture.userId, gen: LEGACY_SESSION_EPOCH_FLOOR }), "EX", 120);
      expect(await session.authenticate(impossibleOld)).toBeNull();
      await session.revokeAllForUser(fixture.userId);
      expect(await session.authenticate(token)).toBeNull();
      expect((await session.authenticate(await fixture.create()))?.user.id).toBe(fixture.userId);
      expect(await session.authenticate(impossibleOld)).toBeNull();
    } finally {
      if (originalMode === undefined) delete process.env.CLOUD_SESSION_ISSUANCE_MODE;
      else process.env.CLOUD_SESSION_ISSUANCE_MODE = originalMode;
      await fixture.cleanup();
    }
  });

  test("serializes concurrent legacy issuance and revokes, then permits only a fresh epoch", async () => {
    const fixture = await createFixture();
    const entered = deferred();
    const release = deferred();
    const realSend = redis.send.bind(redis);
    const send = spyOn(redis, "send").mockImplementation(async (command, args) => {
      if (command === "SET" && args[0]?.startsWith(`session:${fixture.userId}:`)) {
        entered.resolve();
        await release.promise;
      }
      return realSend(command, args);
    });
    try {
      const issuance = fixture.create();
      await entered.promise;
      const revocations = Promise.all([session.revokeAllForUser(fixture.userId), session.revokeAllForUser(fixture.userId)]);
      try {
        await waitForBlockedRevoke();
      } finally {
        release.resolve();
      }
      const issued = await issuance;
      await revocations;
      send.mockRestore();
      expect(await session.authenticate(issued)).toBeNull();
      const fresh = await fixture.create();
      expect((await session.authenticate(fresh))?.data.authEpoch).toBe(2);
      const [state] = await sql<
        { floor: number }[]
      >`SELECT legacy_session_generation::int AS floor FROM auth.users WHERE id = ${fixture.userId}::uuid`;
      expect(state?.floor).toBe(9);
    } finally {
      release.resolve();
      send.mockRestore();
      await fixture.cleanup();
    }
  });

  test("a revoke with an older Redis observation cannot miss issuance's persisted high-water mark", async () => {
    const fixture = await createFixture();
    const observed = deferred();
    const resume = deferred();
    const realGet = redis.get.bind(redis);
    const get = spyOn(redis, "get").mockImplementation(async (key) => {
      const value = await realGet(key);
      if (key === fixture.generationKey) {
        observed.resolve();
        await resume.promise;
      }
      return value;
    });
    try {
      const revocation = session.revokeAllForUser(fixture.userId);
      await observed.promise;
      await redis.set(fixture.generationKey, "20");
      const issued = await fixture.create();
      resume.resolve();
      await revocation;
      get.mockRestore();
      expect(await redis.get(fixture.generationKey)).toBe("21");
      expect(await session.authenticate(issued)).toBeNull();
      expect((await session.authenticate(await fixture.create()))?.user.id).toBe(fixture.userId);
    } finally {
      resume.resolve();
      get.mockRestore();
      await fixture.cleanup();
    }
  });

  test("bounds a stalled Redis write and releases the user lock without issuing a credential", async () => {
    const fixture = await createFixture();
    const realSend = redis.send.bind(redis);
    const send = spyOn(redis, "send").mockImplementation((command, args) =>
      command === "SET" && args[0]?.startsWith(`session:${fixture.userId}:`) ? new Promise<never>(() => {}) : realSend(command, args),
    );
    try {
      await expect(fixture.create()).rejects.toThrow("Legacy session Redis operation timed out");
      send.mockRestore();
      // This update requires the same row lock and proves the timed-out transaction ended.
      await sql`UPDATE auth.users SET auth_epoch = auth_epoch + 1 WHERE id = ${fixture.userId}::uuid`;
      expect((await session.authenticate(await fixture.create()))?.data.authEpoch).toBe(1);
    } finally {
      send.mockRestore();
      await fixture.cleanup();
    }
  }, 15_000);
});
