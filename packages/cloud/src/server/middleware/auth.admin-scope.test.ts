import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { oauthTokens } from "../../services/oauth-tokens";
import { session } from "../../services/session";
import { buildProjectedUser } from "../../services/session/user";
import { type AuthContext, auth } from "./auth";

const user = buildProjectedUser({
  id: "11111111-1111-4111-8111-111111111111",
  uid: "admin",
  provider: "local",
  profile: "user",
  effective_admin: true,
});
const methods = ["POST", "PUT", "PATCH", "DELETE", "PROPFIND"];
beforeEach(() => setSystemTime(new Date("2026-01-02T03:04:05Z")));
afterEach(() => setSystemTime());

test("admin role policies cap OAuth mutations before newly registered handlers", async () => {
  const verify = spyOn(oauthTokens, "verifyAccessToken");
  try {
    for (const roles of [["admin"], ["admin", "group-manager"], ["authenticated", "admin"], ["*", "admin"]] as const) {
      const app = new Hono<AuthContext>().use(auth.requireRole(...roles)).all("/*", (c) => c.text("handler"));
      for (const scopes of [[], ["openid", "read"], ["write"], ["admin"]]) {
        verify.mockResolvedValue({ kind: "user", user, scopes, payload: {} });
        for (const method of methods) {
          const response = await app.request("/new-route", { method, headers: { authorization: "Bearer fixture" } });
          const allowed = scopes.includes("write") || scopes.includes("admin");
          expect(response.status).toBe(allowed ? 200 : 403);
          if (!allowed) expect(await response.json()).toEqual({ code: "FORBIDDEN", message: "OAuth scope write or admin is required" });
        }
        for (const method of ["GET", "HEAD", "OPTIONS"]) {
          expect((await app.request("/new-route", { method, headers: { authorization: "Bearer fixture" } })).status).toBe(200);
        }
      }
    }
  } finally {
    verify.mockRestore();
  }
});

test("browser admin sessions keep access to every mutation method", async () => {
  const authenticate = spyOn(session, "authenticateRequest").mockResolvedValue({
    user,
    data: { userId: user.id, sid: "browser", authEpoch: 0, kind: "web", expiresAt: "2030-01-01T00:00:00Z" },
  });
  try {
    const app = new Hono<AuthContext>().use(auth.requireRole("admin")).all("/*", (c) => c.text("handler"));
    for (const method of methods) {
      expect((await app.request("/new-route", { method, headers: { cookie: "session_token=browser" } })).status).toBe(200);
    }
  } finally {
    authenticate.mockRestore();
  }
});

test("OAuth scopes never grant the administrator role", async () => {
  const verify = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({
    kind: "user",
    user: { ...user, roles: ["user"] },
    scopes: ["admin"],
    payload: {},
  });
  try {
    const app = new Hono<AuthContext>().use(auth.requireRole("admin")).post("/", (c) => c.text("handler"));
    expect((await app.request("/", { method: "POST", headers: { authorization: "Bearer fixture" } })).status).toBe(403);
  } finally {
    verify.mockRestore();
  }
});

test("user-delegated OAuth keeps the same administrator mutation ceiling", async () => {
  const verify = spyOn(oauthTokens, "verifyAccessToken");
  try {
    const app = new Hono<AuthContext>().use(auth.requireRole("admin")).post("/", (c) => c.text("handler"));
    for (const scopes of [["read"], ["write"], ["admin"]]) {
      verify.mockResolvedValue({
        kind: "service_account",
        serviceAccount: {
          id: "22222222-2222-4222-8222-222222222222",
          name: "Delegate",
          kind: "user_delegated",
          status: "active",
          delegatedUserId: user.id,
          appId: null,
          resourceType: null,
          resourceId: null,
          createdAt: "2026-01-01T00:00:00Z",
          createdBy: user.id,
        },
        delegatedUser: user,
        scopes,
        payload: {},
      });
      const response = await app.request("/", { method: "POST", headers: { authorization: "Bearer fixture" } });
      expect(response.status).toBe(scopes.includes("read") ? 403 : 200);
    }
  } finally {
    verify.mockRestore();
  }
});
