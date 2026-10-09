import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { Hono } from "hono";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import type { AuthContext } from "../server";
import { session } from "../services/session";
import * as settings from "../services/settings";
import { TIMEZONE_COOKIE } from "../shared/time";
import meRoutes from "./me";

const suite = databaseSuite();
let router: Hono<AuthContext>;
let issueFor = "";

const insertUser = async () => {
  const id = crypto.randomUUID();
  await sql`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${id}::uuid, ${`quiet-${id}`}, 'local', 'user')`;
  return id;
};
const signIn = async (userId: string) => {
  issueFor = userId;
  const token = (await (await router.request("/issue", { method: "POST" })).json()).token as string;
  await sql`UPDATE auth.session_families SET legal_pending = false WHERE user_id = ${userId}::uuid`;
  return token;
};
const call = (token: string, method: "GET" | "PATCH", body?: unknown) =>
  router.request("/api/me/notifications/quiet", {
    method,
    headers: {
      Cookie: `session_token=${token}; ${TIMEZONE_COOKIE}=Europe/Berlin`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

suite("/api/me/notifications/quiet (isolated Postgres and Valkey)", () => {
  beforeAll(async () => {
    await settings.set("security.rate_limit_per_second", 1000);
    router = new Hono<AuthContext>()
      .post("/issue", async (c) => c.json({ token: await session.create(c, issueFor) }))
      .route("/api/me", meRoutes);
  });

  test("reads, pauses, schedules, and resumes only the caller's quiet time", async () => {
    const userId = await insertUser();
    const otherId = await insertUser();
    const token = await signIn(userId);
    try {
      const initial = await call(token, "GET");
      expect(initial.status).toBe(200);
      // Without saved quiet hours, the browser's time zone is offered.
      expect(await initial.json()).toEqual({
        doNotDisturbUntil: null,
        quietHours: { timeZone: "Europe/Berlin", periods: [] },
        state: { active: false, reason: null, until: null, nextStart: null },
      });

      const until = new Date(Date.now() + 2 * 60 * 60_000);
      until.setUTCSeconds(0, 0);
      const paused = await call(token, "PATCH", { doNotDisturbUntil: until.toISOString() });
      expect(paused.status).toBe(200);
      expect(await paused.json()).toMatchObject({
        doNotDisturbUntil: until.toISOString(),
        state: { active: true, reason: "doNotDisturb", until: until.toISOString() },
      });

      // Replacing quiet hours keeps do not disturb.
      const periods = [{ days: [1, 2, 3, 4, 5], start: "19:00", end: "07:00" }];
      const scheduled = await call(token, "PATCH", { quietHours: { timeZone: "America/New_York", periods } });
      expect(await scheduled.json()).toMatchObject({
        doNotDisturbUntil: until.toISOString(),
        quietHours: { timeZone: "America/New_York", periods },
        state: { reason: "doNotDisturb" },
      });

      const resumed = await call(token, "PATCH", { doNotDisturbUntil: null });
      expect(await resumed.json()).toMatchObject({ doNotDisturbUntil: null, quietHours: { timeZone: "America/New_York", periods } });

      const [other] = await sql`SELECT 1 FROM notifications.quiet_times WHERE user_id = ${otherId}::uuid`;
      expect(other).toBeUndefined();
    } finally {
      await sql`DELETE FROM auth.users WHERE id IN (${userId}::uuid, ${otherId}::uuid)`;
    }
  });

  test("rejects a pause in the past and schedules that do not validate", async () => {
    const userId = await insertUser();
    const token = await signIn(userId);
    try {
      const past = await call(token, "PATCH", { doNotDisturbUntil: new Date(Date.now() - 60_000).toISOString() });
      expect(past.status).toBe(400);
      for (const body of [
        {},
        { quietHours: { timeZone: "Mars/Olympus", periods: [] } },
        { quietHours: { timeZone: "UTC", periods: [{ days: [8], start: "19:00", end: "07:00" }] } },
        { quietHours: { timeZone: "UTC", periods: [{ days: [1], start: "7pm", end: "07:00" }] } },
      ]) {
        expect((await call(token, "PATCH", body)).status).toBe(400);
      }
      const [stored] = await sql`SELECT 1 FROM notifications.quiet_times WHERE user_id = ${userId}::uuid`;
      expect(stored).toBeUndefined();
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
