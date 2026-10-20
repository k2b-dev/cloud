import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestAppSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { settingsFixture } from "../store/settings.test-fixture";
import "../../../../scripts/fixtures/authorization-preload";
import api from ".";

const suite = suiteFor("database", "nats", "valkey");
const users: string[] = [];

suite("Pulse API keys and the mobile app", () => {
  let settings: ReturnType<typeof settingsFixture>;
  beforeAll(() => {
    settings = settingsFixture();
    settings.values["pulse.clickhouse_connection"] = JSON.stringify({
      url: "http://127.0.0.1:1",
      user: "fixture",
      password: "fixture-password",
    });
  });
  afterAll(async () => {
    settings.restore();
    for (const id of users) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  // A resource API key keeps working after the phone is removed, so it needs the web.
  test("an app session cannot create a Pulse source API key", async () => {
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${`pulse-app-${crypto.randomUUID()}`}, 'local', 'user', 'Phone Person') RETURNING id`;
    users.push(user!.id);
    const { token } = await createTestAppSession(user!.id);
    const response = await api.request("/bases/bAs234/sources/sRc234/api-keys", {
      method: "POST",
      headers: { cookie: `pwa_session=${token}`, "content-type": "application/json", "x-forwarded-for": uniqueCallerAddress() },
      body: JSON.stringify({ name: "From the phone", permission: "read" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "FORBIDDEN", message: "Use Cloud on the web for this." });
  });
});
