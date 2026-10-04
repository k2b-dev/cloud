import { afterAll, expect, test } from "bun:test";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { pwaDevices } from "@k2b/cloud/services";
import { pairingSecret } from "@k2b/cloud/services/pairing-secret";
import { createTestAppSession, createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import users from "./users";

const suite = suiteFor("database", "nats", "valkey");
const created: string[] = [];

const person = async (name: string, admin = false) => {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, admin)
    VALUES (${`accounts-app-${crypto.randomUUID()}`}, 'local', 'user', ${name}, ${admin}) RETURNING id`;
  created.push(user!.id);
  return user!.id;
};
const request = (path: string, cookie: string, method = "GET") =>
  users.request(path, { method, headers: { cookie, "x-forwarded-for": uniqueCallerAddress() } });

// Another application's validator and Core's renewal, as the phone meets them at its next request.
const phone = new Hono<AuthContext>()
  .get("/api/probe", auth.requireRole("authenticated"), (c) => c.json({ userId: c.get("user").id }))
  .post("/renew", async (c) => c.json(await pwaDevices.renew(c, { deviceKey: c.req.header("x-device-key"), appSession: null })));

suite("Accounts administration of mobile app phones", () => {
  afterAll(async () => {
    for (const id of created) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("an administrator removes a person's phone, which is signed out at its next request", async () => {
    const adminId = await person("Admin Example", true);
    const ownerId = await person("Ada Example");
    const web = `session_token=${await createTestSession(adminId)}`;
    const owner = await createTestAppSession(ownerId);
    // The fixture stores a placeholder key; give the phone a real one so it can try to renew.
    const secret = pairingSecret.create();
    await sql`UPDATE auth.pwa_devices SET secret_hash = ${pairingSecret.hash(secret)} WHERE id = ${owner.deviceId}::uuid`;
    const ownerCookie = `pwa_session=${owner.token}`;
    expect((await phone.request("/api/probe", { headers: { cookie: ownerCookie } })).status).toBe(200);

    const listed = await request(`/${ownerId}/app-devices`, web);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      devices: [expect.objectContaining({ id: owner.deviceId, name: "Test phone", platform: "other", current: false })],
    });

    const path = `/${ownerId}/app-devices/${owner.deviceId}`;
    expect(await (await request(path, web, "DELETE")).json()).toEqual({ revoked: true });
    expect(await (await request(path, web, "DELETE")).json()).toEqual({ revoked: false });
    expect(await (await request(`/${ownerId}/app-devices`, web)).json()).toEqual({ devices: [] });
    expect((await request(`/${ownerId}/app-devices/${crypto.randomUUID()}`, web, "DELETE")).status).toBe(404);

    // The app session fails, and renewal answers "ended", which the app shows as "This phone was signed out".
    expect((await phone.request("/api/probe", { headers: { cookie: ownerCookie } })).status).toBe(401);
    const renewed = await phone.request("/renew", { method: "POST", headers: { "x-device-key": `${owner.deviceId}.${secret}` } });
    expect(await renewed.json()).toEqual({ outcome: "ended" });

    const [audit] = await sql<{ actor_user_id: string; metadata: { reason: string; targetUserId: string } }[]>`
      SELECT actor_user_id, metadata FROM audit.events WHERE action = 'auth.pwa.device.revoke' AND target_id = ${owner.deviceId}`;
    expect(audit).toMatchObject({ actor_user_id: adminId, metadata: { reason: "admin", targetUserId: ownerId } });
  });

  test("an administrator's own app session cannot list or remove phones", async () => {
    const adminId = await person("Admin Example", true);
    const ownerId = await person("Ada Example");
    const target = await createTestAppSession(ownerId);
    const app = `pwa_session=${(await createTestAppSession(adminId)).token}`;
    expect((await request(`/${ownerId}/app-devices`, app)).status).toBe(403);
    expect((await request(`/${ownerId}/app-devices/${target.deviceId}`, app, "DELETE")).status).toBe(403);
    const [device] = await sql<{ revoked_at: Date | null }[]>`SELECT revoked_at FROM auth.pwa_devices WHERE id = ${target.deviceId}::uuid`;
    expect(device?.revoked_at).toBeNull();
  });
});
