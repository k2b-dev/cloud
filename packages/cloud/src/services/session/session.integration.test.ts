import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { redis, sql } from "bun";
import { session } from "./index";

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
