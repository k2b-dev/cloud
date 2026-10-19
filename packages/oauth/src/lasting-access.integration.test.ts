import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { type AuthContext, auth, v } from "@k2b/cloud/server";
import { session } from "@k2b/cloud/services/session";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import type { OAuthClient } from "./contracts";
import { ConsentDecisionSchema, completeConsent } from "./frontend/consent-action";
import { resolveDeviceView } from "./frontend/device";
import { completeDeviceDecision, DeviceDecisionSchema } from "./frontend/device-action";
import { migrate } from "./migrate";
import routes from "./oauth";
import { oauth } from "./service/oauth";
import { BrowserSignInRequiredError } from "./service/sign-in";

const suite = suiteFor("database", "valkey", "nats");
const origin = "http://localhost:3000";
const redirectUri = "http://127.0.0.1:54321/callback";
const challenge = "c".repeat(64);
const users: string[] = [];
const clients: string[] = [];
const decisions = new Hono<AuthContext>()
  .use(auth.requireRole("authenticated"), auth.requireUser())
  .post("/oauth/consent", v("form", ConsentDecisionSchema), (c) => completeConsent(c, c.req.valid("form")))
  .post("/oauth/device", v("form", DeviceDecisionSchema), (c) => completeDeviceDecision(c, c.req.valid("form")))
  .get("/oauth/device", async (c) => c.json(await resolveDeviceView(c)));

const person = async () => {
  const [row] = await sql<{ id: string; auth_epoch: string }[]>`
    INSERT INTO auth.users (uid, provider, profile) VALUES (${crypto.randomUUID()}, 'local', 'user') RETURNING id, auth_epoch
  `;
  if (!row) throw new Error("Missing person");
  users.push(row.id);
  const token = await createTestSession(row.id);
  const signedIn = await session.authenticate(token);
  if (!signedIn) throw new Error("Missing browser session");
  return { userId: row.id, authEpoch: Number(row.auth_epoch), sid: signedIn.data.sid, cookie: `session_token=${token}` };
};
const age = (sid: string) => sql`UPDATE auth.session_families SET issued_at = now() - interval '11 minutes' WHERE sid = ${sid}::uuid`;
const fresh = (sid: string) => sql`UPDATE auth.session_families SET issued_at = now() WHERE sid = ${sid}::uuid`;
const frozen = async (run: () => Promise<void>) => {
  const [clock] = await sql<{ now: Date }[]>`SELECT now() AS now`;
  setSystemTime(clock!.now);
  try {
    await run();
  } finally {
    setSystemTime();
  }
};
const firstParty = async () => {
  const client = await oauth.clients.getByClientId({ clientId: "cloud-cli" });
  if (!client) throw new Error("Missing command line client");
  return client;
};
const managed = async () => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO oauth.clients (name, redirect_uris, scopes)
    VALUES (${crypto.randomUUID()}, ARRAY[${redirectUri}], ARRAY['openid', 'offline_access']) RETURNING id
  `;
  if (!row) throw new Error("Missing managed client");
  clients.push(row.id);
  const client = await oauth.clients.get({ id: row.id });
  if (!client) throw new Error("Missing managed client");
  return client;
};
const authorize = (who: Awaited<ReturnType<typeof person>>, client: OAuthClient, scopes = "openid offline_access") =>
  routes.request(
    `/oauth/authorize?${new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopes,
      code_challenge: challenge,
      code_challenge_method: "S256",
    })}`,
    { headers: { cookie: who.cookie, "x-forwarded-for": uniqueCallerAddress() } },
  );
const post = (path: string, cookie: string, values: Record<string, string>) =>
  decisions.request(path, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });

suite("Lasting OAuth access requires confirmed browser sign-in", () => {
  beforeAll(migrate);
  afterAll(async () => {
    for (const id of clients) await sql`DELETE FROM oauth.clients WHERE id = ${id}::uuid`;
    for (const id of users) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("the command line always goes through consent and fresh approval records evidence", () =>
    frozen(async () => {
      const who = await person();
      const response = await authorize(who, await firstParty());
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!, origin);
      expect(location.pathname).toBe("/oauth/consent");
      expect(location.searchParams.has("code")).toBe(false);
      const request = location.searchParams.get("request")!;
      expect(await oauth.consent.get(request)).toMatchObject({ resource: null, clientId: "cloud-cli" });
      const approved = await post("/oauth/consent", who.cookie, { request, decision: "approve" });
      const code = new URL(approved.headers.get("location")!, origin).searchParams.get("code");
      expect(code).toBeTruthy();
      const [row] = await sql`SELECT confirmed_sid, confirmed_at FROM oauth.codes WHERE code = ${code}`;
      expect(row.confirmed_sid).toBe(who.sid);
      expect(row.confirmed_at).toBeInstanceOf(Date);
    }));

  test("managed offline access returns through confirmation, while short access still gets a code", () =>
    frozen(async () => {
      const who = await person();
      const client = await managed();
      await age(who.sid);
      const response = await authorize(who, client);
      const location = new URL(response.headers.get("location")!, origin);
      expect(location.pathname).toBe("/auth/login");
      const returnTo = new URL(location.searchParams.get("redirectTo")!, origin);
      expect(returnTo.pathname).toBe("/oauth/authorize");
      expect(returnTo.searchParams.get("reauthenticate")).toBe("1");
      expect(await sql`SELECT code FROM oauth.codes WHERE user_id = ${who.userId}::uuid`).toHaveLength(0);
      const short = await authorize(who, client, "openid");
      expect(new URL(short.headers.get("location")!).searchParams.get("code")).toBeTruthy();
      await fresh(who.sid);
      const confirmed = await authorize(who, client);
      const code = new URL(confirmed.headers.get("location")!).searchParams.get("code");
      const [row] = await sql`SELECT confirmed_sid, confirmed_at FROM oauth.codes WHERE code = ${code}`;
      expect(row.confirmed_sid).toBe(who.sid);
      expect(row.confirmed_at).toBeInstanceOf(Date);
    }));

  test("stale dynamic approval preserves the request and writes no code; denial remains available", () =>
    frozen(async () => {
      const who = await person();
      const client = await oauth.clients.registerDynamic({
        name: "Confirmation client",
        redirectUris: [redirectUri],
        scopes: ["read", "offline_access"],
      });
      clients.push(client.id);
      const requestData = {
        userId: who.userId,
        clientId: client.clientId,
        redirectUri,
        scopes: client.scopes,
        resource: `${origin}/api/mcp/v1`,
        codeChallenge: challenge,
        codeChallengeMethod: "S256" as const,
      };
      const request = await oauth.consent.create(requestData);
      await age(who.sid);
      const response = await post("/oauth/consent", who.cookie, { request, decision: "approve" });
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get("location")!, origin);
      expect(location.pathname).toBe("/oauth/consent");
      const renewed = location.searchParams.get("request")!;
      expect(renewed).not.toBe(request);
      expect(await oauth.consent.get(renewed)).toEqual(requestData);
      expect(await sql`SELECT code FROM oauth.codes WHERE user_id = ${who.userId}::uuid`).toHaveLength(0);
      const denied = await post("/oauth/consent", who.cookie, { request: renewed, decision: "deny" });
      expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    }));

  test("code service refuses missing, mismatched and stale confirmation without inserting", () =>
    frozen(async () => {
      const who = await person();
      const params = {
        clientId: "cloud-cli",
        userId: who.userId,
        authEpoch: who.authEpoch,
        redirectUri,
        scopes: ["openid", "offline_access"] as ("openid" | "offline_access")[],
      };
      await expect(oauth.codes.create(params)).rejects.toThrow("browser sign-in and a transaction");
      await expect(oauth.codes.create({ ...params, db: sql, browserSignIn: who })).rejects.toThrow("browser sign-in and a transaction");
      await expect(
        sql.begin((db) => oauth.codes.create({ ...params, db, browserSignIn: { userId: crypto.randomUUID(), sid: who.sid } })),
      ).rejects.toThrow("FORBIDDEN");
      await age(who.sid);
      await expect(sql.begin((db) => oauth.codes.create({ ...params, db, browserSignIn: who }))).rejects.toBeInstanceOf(
        BrowserSignInRequiredError,
      );
      expect(await sql`SELECT code FROM oauth.codes WHERE user_id = ${who.userId}::uuid`).toHaveLength(0);
    }));

  test("device approval rechecks at the write and leaves stale requests pending for a fresh confirmation", () =>
    frozen(async () => {
      const who = await person();
      const client = await firstParty();
      const started = await oauth.device.create({ client, scopes: ["openid", "offline_access"] });
      const getView = async () => {
        const response = await decisions.request(`/oauth/device?user_code=${started.userCode}`, {
          headers: { cookie: who.cookie, "x-forwarded-for": uniqueCallerAddress() },
        });
        return response.json() as Promise<{ kind: string; request: string; reauthenticateHref: string | null }>;
      };
      const initial = await getView();
      expect(initial.reauthenticateHref).toBeNull();
      await age(who.sid);
      const response = await post("/oauth/device", who.cookie, {
        request: initial.request,
        decision: "approve",
        user_code: started.userCode,
      });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`/oauth/device?user_code=${oauth.device.formatUserCode(started.userCode)}`);
      const [pending] =
        await sql`SELECT status, confirmed_sid, confirmed_at FROM oauth.device_authorizations WHERE id = ${started.id}::uuid`;
      expect(pending).toMatchObject({ status: "pending", confirmed_sid: null, confirmed_at: null });
      const stale = await getView();
      expect(stale.reauthenticateHref).toContain("/auth/login?redirectTo=");
      expect(
        new URL(new URL(stale.reauthenticateHref!, origin).searchParams.get("redirectTo")!, origin).searchParams.get("reauthenticate"),
      ).toBe("1");
      await fresh(who.sid);
      const approved = await post("/oauth/device", who.cookie, { request: stale.request, decision: "approve" });
      expect(approved.headers.get("location")).toBe("/oauth/device?result=approved");
      const [row] = await sql`SELECT status, confirmed_sid, confirmed_at FROM oauth.device_authorizations WHERE id = ${started.id}::uuid`;
      expect(row).toMatchObject({ status: "approved", confirmed_sid: who.sid, confirmed_at: expect.any(Date) });
    }));

  test("device stale approval without a matching return code explains how to resume, and denial needs no recent sign-in", () =>
    frozen(async () => {
      const who = await person();
      const started = await oauth.device.create({ client: await firstParty(), scopes: ["offline_access"] });
      await age(who.sid);
      const request = await oauth.device.createConfirmation({ deviceAuthorizationId: started.id, userId: who.userId });
      const response = await post("/oauth/device", who.cookie, { request, decision: "approve", user_code: "ABCD-EFGH" });
      const location = new URL(response.headers.get("location")!, origin);
      expect(location.searchParams.get("error_description")).toBe("Sign in again in the browser, then enter the code again.");
      const denial = await oauth.device.createConfirmation({ deviceAuthorizationId: started.id, userId: who.userId });
      expect((await post("/oauth/device", who.cookie, { request: denial, decision: "deny" })).headers.get("location")).toBe(
        "/oauth/device?result=denied",
      );
    }));
});
