import { afterAll, expect, test } from "bun:test";
import { createTestAppSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import api from ".";

const suite = suiteFor("database", "nats", "valkey");
const users: string[] = [];

suite("Venue API keys and the mobile app", () => {
  afterAll(async () => {
    for (const id of users) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  // A resource API key keeps working after the phone is removed, so it needs the web.
  test("an app session cannot create a venue API key", async () => {
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${`venue-app-${crypto.randomUUID()}`}, 'local', 'user', 'Phone Person') RETURNING id`;
    users.push(user!.id);
    const { token } = await createTestAppSession(user!.id);
    const response = await api.request("/venues/vNu234/api-keys", {
      method: "POST",
      headers: { cookie: `pwa_session=${token}`, "content-type": "application/json", "x-forwarded-for": uniqueCallerAddress() },
      body: JSON.stringify({ name: "From the phone", permission: "read" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "FORBIDDEN", message: "Use Cloud on the web for this." });
  });
});
