import { afterAll, beforeAll, expect, test } from "bun:test";
import { type AuthContext, auth, v } from "@k2b/cloud/server";
import { toPgUuidArray } from "@k2b/cloud/services";
import { createTestAppSession, createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import { ConsentDecisionSchema, completeConsent } from "./frontend/consent-action";
import { resolveDeviceView } from "./frontend/device";
import { completeDeviceDecision, DeviceDecisionSchema } from "./frontend/device-action";
import { oauthMessages } from "./frontend/messages";
import { migrate } from "./migrate";
import oauthRoutes from "./oauth";
import { oauth } from "./service/oauth";

// The mobile app's session never grants access to other applications: OAuth needs the web.
const suite = suiteFor("database", "valkey", "nats");
const ISSUER = "http://localhost:3000";
const createdUsers: string[] = [];
const createdClients: string[] = [];

const routes = () =>
  new Hono<AuthContext>()
    .get("/oauth/device", auth.requireRole("authenticated"), auth.requireUser(), async (c) => c.json(await resolveDeviceView(c)))
    .post("/oauth/device", auth.requireRole("authenticated"), auth.requireUser(), v("form", DeviceDecisionSchema), (c) =>
      completeDeviceDecision(c, c.req.valid("form")),
    )
    .post("/oauth/consent", auth.requireRole("authenticated"), auth.requireUser(), v("form", ConsentDecisionSchema), (c) =>
      completeConsent(c, c.req.valid("form")),
    );

const person = async () => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name) VALUES (${`oauth-app-${crypto.randomUUID()}`}, 'local', 'user', 'App Person')
    RETURNING id`;
  createdUsers.push(row!.id);
  return row!.id;
};
const post = (path: string, cookie: string, values: Record<string, string>) =>
  routes().request(path, {
    method: "POST",
    headers: { cookie, origin: ISSUER, "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": uniqueCallerAddress() },
    body: new URLSearchParams(values),
  });
const blocked = encodeURIComponent(oauthMessages.resolve(["en"]).t.webSessionRequired);

suite("OAuth refuses the mobile app's session", () => {
  beforeAll(async () => {
    await migrate();
  });
  afterAll(async () => {
    if (createdClients.length > 0) await sql`DELETE FROM oauth.clients WHERE id = ANY(${toPgUuidArray(createdClients)}::uuid[])`;
    if (createdUsers.length > 0) await sql`DELETE FROM auth.users WHERE id = ANY(${toPgUuidArray(createdUsers)}::uuid[])`;
  });

  test("the device page and its decision need a web session", async () => {
    const userId = await person();
    const { token } = await createTestAppSession(userId);
    const page = await routes().request("/oauth/device", {
      headers: { cookie: `pwa_session=${token}`, "x-forwarded-for": uniqueCallerAddress() },
    });
    expect(page.status).toBe(403);
    expect(await page.json()).toMatchObject({
      kind: "result",
      outcome: "blocked",
      message: oauthMessages.resolve(["en"]).t.webSessionRequired,
    });
    const decision = await post("/oauth/device", `pwa_session=${token}`, { request: crypto.randomUUID(), decision: "approve" });
    expect(decision.headers.get("location")).toContain(blocked);
    const web = await routes().request("/oauth/device", {
      headers: { cookie: `session_token=${await createTestSession(userId)}`, "x-forwarded-for": uniqueCallerAddress() },
    });
    expect(await web.json()).toMatchObject({ kind: "entry" });
  });

  test("a consent decision needs a web session", async () => {
    const userId = await person();
    const { token } = await createTestAppSession(userId);
    const response = await post("/oauth/consent", `pwa_session=${token}`, { request: crypto.randomUUID(), decision: "approve" });
    expect(response.headers.get("location")).toContain(blocked);
  });

  test("authorize treats the app session as no session", async () => {
    const userId = await person();
    const { token } = await createTestAppSession(userId);
    const actor = { id: userId, uid: "admin", provider: "local", roles: ["admin"] };
    const created = await oauth.clients.create({
      actor,
      data: {
        name: `App session ${crypto.randomUUID()}`,
        isPublic: false,
        redirectUris: ["https://client.example.test/callback"],
        scopes: ["openid" as const],
        audiences: ["cloud"],
        allowedProfiles: ["user" as const],
        accessMode: "profiles" as const,
        allowedUserIds: [],
        allowedGroupIds: [],
      },
    });
    if (!created.ok) throw new Error("client setup failed");
    createdClients.push(created.data.id);
    const query = new URLSearchParams({
      client_id: created.data.clientId,
      redirect_uri: "https://client.example.test/callback",
      response_type: "code",
      scope: "openid",
      state: "s",
    });
    const authorize = (cookie: string) => oauthRoutes.request(`/oauth/authorize?${query}`, { headers: { cookie } });
    expect((await authorize(`pwa_session=${token}`)).headers.get("location")).toStartWith("/auth/login");
    expect((await authorize(`session_token=${await createTestSession(userId)}`)).headers.get("location")).not.toStartWith("/auth/login");
  });
});
