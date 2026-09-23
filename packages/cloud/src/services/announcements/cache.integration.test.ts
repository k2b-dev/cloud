import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { redis, sql } from "bun";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { buildProjectedUser } from "../session/user";
import { announcements } from "./index";

const suite = suiteFor("database", "valkey");
const key = "appglobalcache:shared:announcements:v1";
const userId = crypto.randomUUID();
const ids: string[] = [];
const state = { seenAnnouncementVersion: 0, dismissedBannerVersions: [] };
const actor = buildProjectedUser({ id: userId, uid: userId, provider: "local", profile: "user", effective_admin: true });
const create = async (kind: "banner" | "announcement", publishedAt: string, expiresAt: string | null = null) => {
  const result = await announcements.admin.create({
    actorId: userId,
    data: { kind, title: "Cache test", body: "**Test**", tone: "info", publishedAt, expiresAt },
  });
  if (!result.ok) throw new Error("Fixture creation failed");
  ids.push(result.data.id);
  return result.data;
};
suite("shared announcement cache", () => {
  beforeAll(async () => {
    await sql`INSERT INTO auth.users (id,uid,provider,profile) VALUES (${userId},${userId},'local','user')`;
    await redis.del(key);
  });
  afterAll(async () => {
    for (const id of ids) await sql`DELETE FROM announcements.entries WHERE id=${id}`;
    await sql`DELETE FROM auth.users WHERE id=${userId}`;
    await redis.del(key);
  });
  test("caches empty results and invalidates create, update, delete and admin clear", async () => {
    expect((await announcements.active.forState({ state })).banners).toEqual([]);
    expect(await redis.get(key)).toBe("[]");
    const banner = await create("banner", new Date(Date.now() - 1000).toISOString());
    expect(await redis.get(key)).toBeNull();
    expect((await announcements.active.forState({ state })).banners.map((x) => x.id)).toContain(banner.id);
    expect((await announcements.active.forState({ state: { ...state, dismissedBannerVersions: [banner.version] } })).banners).toEqual([]);
    expect((await announcements.admin.update({ id: banner.id, actorId: userId, data: { title: "Updated" } })).ok).toBe(true);
    expect(await redis.get(key)).toBeNull();
    expect((await announcements.active.forState({ state })).banners[0]?.title).toBe("Updated");
    await announcements.admin.invalidateCache(actor);
    expect(await redis.get(key)).toBeNull();
    await announcements.active.forState({ state });
    expect((await announcements.admin.remove({ id: banner.id })).ok).toBe(true);
    expect(await redis.get(key)).toBeNull();
  });
  test("applies scheduling and expiry to a warm shared snapshot without leaking cookie state", async () => {
    // Boundaries a minute ahead stay in the future however slow the setup is; the read-time
    // filter then crosses them on a moved wall clock while the Valkey snapshot stays warm.
    const boundary = Date.now() + 60_000;
    const scheduled = await create("announcement", new Date(boundary).toISOString());
    const expiring = await create("banner", new Date(Date.now() - 1000).toISOString(), new Date(boundary).toISOString());
    const before = await announcements.active.forState({ state });
    expect(before.announcements.some((x) => x.id === scheduled.id)).toBe(false);
    expect(before.banners.some((x) => x.id === expiring.id)).toBe(true);
    const cached = await redis.get(key);
    setSystemTime(new Date(boundary + 1_000));
    try {
      const after = await announcements.active.forState({ state });
      expect(after.announcements.some((x) => x.id === scheduled.id)).toBe(true);
      expect(after.banners.some((x) => x.id === expiring.id)).toBe(false);
      expect(await redis.get(key)).toBe(cached);
      expect(
        (await announcements.active.forState({ state: { ...state, seenAnnouncementVersion: scheduled.version } })).announcements,
      ).toEqual([]);
      expect((await announcements.active.forState({ state })).announcements).toHaveLength(1);
    } finally {
      setSystemTime();
    }
  });
});
