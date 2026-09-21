import { afterAll, beforeAll, expect, test } from "bun:test";
import { redis, sql } from "bun";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { encryptValue } from "../settings/crypto";
import { loadJwtSessionIdentity, loadJwtSessionUser } from "./user";

const suite = suiteFor("database", "valkey");
const userId = crypto.randomUUID(),
  sid = crypto.randomUUID(),
  kid = crypto.randomUUID();
const groups = Array.from({ length: 4 }, () => crypto.randomUUID());
const input = { userId, sid, authEpoch: 0, groupsAdmin: [] };
suite("uncached policy and consolidated group projection", () => {
  beforeAll(async () => {
    await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${userId}, ${userId}, 'local', 'user')`;
    await sql`INSERT INTO auth.signing_keys (purpose, state, kid, public_jwk, encrypted_private_jwk, encryption_key_id, activate_at, activated_at, sign_until, retired_at, verify_until)
      VALUES ('session', 'retired', ${kid}, '{}'::jsonb, 'test', 'test', now()-INTERVAL '2 days', now()-INTERVAL '2 days', now()-INTERVAL '1 day', now()-INTERVAL '1 day', now()+INTERVAL '1 day')`;
    await sql`INSERT INTO auth.session_families (sid,user_id,auth_epoch,signing_kid,issued_at,expires_at)
      VALUES (${sid},${userId},0,${kid},now(),now()+INTERVAL '1 hour')`;
    for (const [i, id] of groups.entries())
      await sql`INSERT INTO auth.groups (id,cn,name,provider) VALUES (${id},${id},${`cache-${userId}-${i}`},${i === 3 ? "ipa" : "local"})`;
    await sql`INSERT INTO auth.user_groups_v2 (user_id,group_id) VALUES (${userId},${groups[0]})`;
    await sql`INSERT INTO auth.group_groups_v2 (parent_group_id,child_group_id) VALUES (${groups[1]},${groups[0]}),(${groups[0]},${groups[1]})`;
    await sql`INSERT INTO auth.group_manager_groups_v2 (group_id,manager_group_id) VALUES (${groups[2]},${groups[1]})`;
    await sql`INSERT INTO auth.group_manager_users_v2 (group_id,user_id) VALUES (${groups[2]},${userId})`;
  });
  afterAll(async () => {
    await sql`DELETE FROM auth.users WHERE id=${userId}`;
    await sql`DELETE FROM auth.signing_keys WHERE kid=${kid}`;
    for (const id of groups) await sql`DELETE FROM auth.groups WHERE id=${id}`;
    await sql`DELETE FROM settings.entries WHERE key='user.category.login.enabled'`;
    await redis.del("settings:user.category.login.enabled");
  });
  test("preserves direct membership and nested manager grants, cycles and provider separation", async () => {
    await expect(
      Promise.resolve(sql`INSERT INTO auth.group_manager_groups_v2 (group_id,manager_group_id) VALUES (${groups[3]},${groups[1]})`),
    ).rejects.toThrow("same provider");
    const user = await loadJwtSessionUser(input);
    expect(user?.memberofGroupIds).toEqual([groups[0]!]);
    expect(user?.memberofGroup).toEqual([`cache-${userId}-0`]);
    expect(user?.managesGroupIds).toEqual([groups[2]!]);
    expect(user?.manages).toEqual([`cache-${userId}-2`]);
    expect((await loadJwtSessionIdentity(input))?.userId).toBe(userId);
  });
  test("ignores stale settings cache and rejects disabled or malformed durable category policy", async () => {
    await redis.set("settings:user.category.login.enabled", "true");
    await sql`INSERT INTO settings.entries (key,value) VALUES ('user.category.login.enabled',${await encryptValue(false)}) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`;
    expect(await loadJwtSessionUser(input)).toBeNull();
    expect(await loadJwtSessionIdentity(input)).toBeNull();
    await sql`UPDATE settings.entries SET value=${await encryptValue("true")} WHERE key='user.category.login.enabled'`;
    await expect(loadJwtSessionUser(input)).rejects.toThrow("Invalid account category");
    await expect(loadJwtSessionIdentity(input)).rejects.toThrow("Invalid account category");
    await sql`UPDATE settings.entries SET value=${await encryptValue(true)} WHERE key='user.category.login.enabled'`;
    expect((await loadJwtSessionUser(input))?.id).toBe(userId);
    expect((await loadJwtSessionIdentity(input))?.userId).toBe(userId);
  });
});
