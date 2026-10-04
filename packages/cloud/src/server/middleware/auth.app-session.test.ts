import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { User } from "../../contracts/shared";
import { oauthTokens } from "../../services/oauth-tokens";
import { type AuthenticatedSession, session } from "../../services/session";
import { buildProjectedUser } from "../../services/session/user";
import { type AuthContext, auth } from "./auth";

const user: User = buildProjectedUser({ id: "7bd9706e-6c70-4dd5-946f-0caac02bfc2a", uid: "ada", provider: "local", profile: "user" });
const sessions: Record<string, AuthenticatedSession> = {
  "web-valid": { user, data: { userId: user.id, sid: "web", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z", kind: "web" } },
  "app-valid": {
    user,
    data: { userId: user.id, sid: "app", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z", kind: "app", deviceId: "phone" },
  },
  // A web family copied into the app cookie still authenticates as what its row says.
  "web-in-app-cookie": { user, data: { userId: user.id, sid: "web2", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z", kind: "web" } },
};
const spy = spyOn(session, "authenticateRequest").mockImplementation(async (_c, token) => sessions[token] ?? null);
spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue(null);
afterEach(() => spy.mockClear());

const cookie = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
type Probe = { path?: string; cookies?: Record<string, string>; authorization?: string; navigate?: boolean };
const headers = ({ cookies = {}, authorization, navigate }: Probe) => ({
  ...(Object.keys(cookies).length ? { cookie: cookie(cookies) } : {}),
  ...(authorization ? { authorization } : {}),
  ...(navigate ? { "sec-fetch-mode": "navigate" } : { "sec-fetch-mode": "cors" }),
});

const tokenProbe = new Hono().all("*", (c) => c.json({ token: session.getToken(c) }));
const token = async (probe: Probe) =>
  ((await (await tokenProbe.request(probe.path ?? "/api/x", { headers: headers(probe) })).json()) as { token: string | null }).token;

const actorProbe = new Hono<AuthContext>()
  .use(auth.requireRole("authenticated"))
  .all("*", (c) => c.json({ sid: auth.getAuthority(c).actor.kind === "user" ? c.get("sessionToken") : null, kind: c.get("sessionKind") }));
const actor = async (probe: Probe) => {
  const response = await actorProbe.request(probe.path ?? "/api/x", { headers: headers(probe) });
  return response.status === 200 ? ((await response.json()) as { sid: string; kind: string }) : response.status;
};

describe("credential resolution without the mobile app", () => {
  // Every row without pwa_session is today's behaviour.
  test("keeps bearer precedence, API keys and the web cookie unchanged", async () => {
    expect(await token({})).toBeNull();
    expect(await token({ authorization: "Bearer explicit", cookies: { session_token: "web-valid" } })).toBe("explicit");
    expect(await token({ authorization: "Bearer cld_prefix_secret", cookies: { session_token: "web-valid" } })).toBeNull();
    expect(await token({ cookies: { session_token: "web-valid" } })).toBe("web-valid");
    expect(await token({ cookies: { session_token: "web-valid" }, navigate: true })).toBe("web-valid");
    expect(await token({ path: "/app/spaces", cookies: { session_token: "web-valid" }, navigate: true })).toBe("web-valid");
  });

  test("authenticates the web session as kind web", async () => {
    expect(await actor({ cookies: { session_token: "web-valid" } })).toEqual({ sid: "web-valid", kind: "web" });
    expect(await actor({ cookies: { session_token: "revoked" } })).toBe(401);
  });
});

describe("credential resolution with the mobile app", () => {
  test("pages below /pwa/ read only the app session, whatever else the request carries", async () => {
    const all = { session_token: "web-valid", pwa_session: "app-valid" };
    expect(await token({ path: "/pwa/spaces", cookies: all, navigate: true })).toBe("app-valid");
    expect(await token({ path: "/pwa/", cookies: { session_token: "web-valid" } })).toBeNull();
    expect(await token({ path: "/pwa", cookies: all, authorization: "Bearer explicit" })).toBe("app-valid");
    expect(await actor({ path: "/pwa/spaces", cookies: all, navigate: true })).toEqual({ sid: "app-valid", kind: "app" });
    expect(await actor({ path: "/pwa/spaces", cookies: { session_token: "web-valid" }, navigate: true })).toBe(401);
    expect(await actor({ path: "/pwa/spaces", cookies: { pwa_session: "web-in-app-cookie" } })).toBe(401);
    expect(await actor({ path: "/pwa/spaces", authorization: "Bearer cld_prefix_secret" })).toBe(401);
  });

  test("Core's /pwa/_auth follows the ordinary rules", async () => {
    expect(await token({ path: "/pwa/_auth/session/renew", cookies: { session_token: "web-valid", pwa_session: "app-valid" } })).toBe(
      "web-valid",
    );
    expect(await token({ path: "/pwa/_auth", cookies: { pwa_session: "app-valid" } })).toBe("app-valid");
  });

  test("navigations elsewhere use only the web session", async () => {
    expect(await token({ path: "/app/spaces", cookies: { pwa_session: "app-valid" }, navigate: true })).toBeNull();
    expect(await actor({ path: "/app/spaces", cookies: { pwa_session: "app-valid" }, navigate: true })).toBe(401);
    expect(await actor({ path: "/app/spaces", cookies: { session_token: "revoked", pwa_session: "app-valid" }, navigate: true })).toBe(401);
  });

  test("other requests prefer a valid web session and fall back to the app session", async () => {
    expect(await actor({ cookies: { session_token: "web-valid", pwa_session: "app-valid" } })).toEqual({ sid: "web-valid", kind: "web" });
    expect(await actor({ cookies: { pwa_session: "app-valid" } })).toEqual({ sid: "app-valid", kind: "app" });
    // A copied or revoked web cookie never hides a valid app session.
    expect(await actor({ cookies: { session_token: "revoked", pwa_session: "app-valid" } })).toEqual({ sid: "app-valid", kind: "app" });
    expect(await actor({ cookies: { session_token: "revoked", pwa_session: "also-revoked" } })).toBe(401);
    // An explicit bearer is never replaced by a cookie.
    expect(await actor({ authorization: "Bearer revoked", cookies: { pwa_session: "app-valid" } })).toBe(401);
  });

  test("WebSocket upgrades follow the fetch rule outside /pwa/ and the app rule inside", async () => {
    const upgrade = (path: string, cookies: Record<string, string>) =>
      tokenProbe.request(path, { headers: { cookie: cookie(cookies), "sec-fetch-mode": "websocket" } });
    const read = async (response: Response) => ((await response.json()) as { token: string | null }).token;
    expect(await read(await upgrade("/api/spaces/ws", { pwa_session: "app-valid" }))).toBe("app-valid");
    expect(await read(await upgrade("/api/spaces/ws", { session_token: "web-valid", pwa_session: "app-valid" }))).toBe("web-valid");
    expect(await read(await upgrade("/pwa/spaces/ws", { session_token: "web-valid" }))).toBeNull();
  });

  test("handlers that authenticate the token themselves get the same validity fallback", async () => {
    const resolveProbe = new Hono().all("*", async (c) => c.json({ token: await session.resolveToken(c) }));
    const resolve = async (cookies: Record<string, string>, extra: Record<string, string> = {}) =>
      (
        (await (
          await resolveProbe.request("/api/spaces/ws", { headers: { cookie: cookie(cookies), "sec-fetch-mode": "websocket", ...extra } })
        ).json()) as { token: string | null }
      ).token;
    // Android: a stale web cookie next to a valid app session in the shared jar.
    expect(await resolve({ session_token: "revoked", pwa_session: "app-valid" })).toBe("app-valid");
    expect(await resolve({ session_token: "web-valid", pwa_session: "app-valid" })).toBe("web-valid");
    expect(await resolve({ session_token: "revoked" })).toBe("revoked");
    expect(await resolve({ session_token: "revoked", pwa_session: "app-valid" }, { authorization: "Bearer explicit" })).toBe("explicit");
    // Without an app session nothing is authenticated up front: today's cost.
    spy.mockClear();
    await resolve({ session_token: "web-valid" });
    expect(spy).not.toHaveBeenCalled();
  });

  test("requests without fetch metadata count as fetches", async () => {
    const response = await actorProbe.request("/api/x", { headers: { cookie: "pwa_session=app-valid" } });
    expect(await response.json()).toEqual({ sid: "app-valid", kind: "app" });
  });

  test("auth.isAppSession reflects the family, not the cookie name", async () => {
    const probe = new Hono<AuthContext>().use(auth.requireRole("authenticated")).get("*", (c) => c.json(auth.isAppSession(c)));
    expect(await (await probe.request("/api/x", { headers: { cookie: "pwa_session=app-valid" } })).json()).toBe(true);
    expect(await (await probe.request("/api/x", { headers: { cookie: "pwa_session=web-in-app-cookie" } })).json()).toBe(false);
  });

  test("auth.rejectAppSession answers the standard 403 for the app and lets the web through", async () => {
    const guarded = new Hono<AuthContext>()
      .use(auth.requireRole("authenticated"))
      .post("*", auth.rejectAppSession, (c) => c.json({ ok: true }));
    const app = await guarded.request("/api/x", { method: "POST", headers: { cookie: "pwa_session=app-valid" } });
    expect(app.status).toBe(403);
    expect(await app.json()).toEqual({ code: "FORBIDDEN", message: "Use Cloud on the web for this." });
    const web = await guarded.request("/api/x", { method: "POST", headers: { cookie: "session_token=web-valid" } });
    expect(web.status).toBe(200);
  });

  test("the request actor of an app session carries the app marker", async () => {
    const probe = new Hono<AuthContext>().use(auth.requireRole("authenticated")).get("*", (c) => c.json(c.get("actor")));
    expect(await (await probe.request("/api/x", { headers: { cookie: "pwa_session=app-valid" } })).json()).toMatchObject({
      kind: "user",
      sessionKind: "app",
    });
    expect(await (await probe.request("/api/x", { headers: { cookie: "session_token=web-valid" } })).json()).not.toHaveProperty(
      "sessionKind",
    );
  });
});
