import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { oauthTokens } from "../../services/oauth-tokens";
import { buildProjectedUser } from "../../services/session/user";
import { type AuthContext, auth } from "./auth";

const user = buildProjectedUser({
  id: "11111111-1111-4111-8111-111111111111",
  uid: "scope-user",
  provider: "local",
  profile: "user",
});
const headers = { authorization: "Bearer fixture" };
beforeEach(() => setSystemTime(new Date("2026-01-02T03:04:05Z")));
afterEach(() => setSystemTime());

test("every authentication entry point caps ordinary OAuth mutations", async () => {
  const verify = spyOn(oauthTokens, "verifyAccessToken");
  try {
    for (const authenticate of [
      auth.requireRole("authenticated"),
      auth.requireRole("user"),
      auth.requireRole("*"),
      auth.requireUser(),
      auth.requireAccount({ provider: "local" }),
    ]) {
      let writes = 0;
      const app = new Hono<AuthContext>().use(authenticate).all("/*", (c) => {
        writes++;
        return c.text("ok");
      });
      for (const scopes of [[], ["read"], ["openid", "profile"], ["write"], ["admin"]]) {
        verify.mockResolvedValue({ kind: "user", user, scopes, payload: {} });
        for (const method of ["POST", "PUT", "PATCH", "DELETE", "PROPFIND"]) {
          const before = writes;
          const response = await app.request("/new-resource", { method, headers });
          const allowed = scopes.includes("write") || scopes.includes("admin");
          expect(response.status).toBe(allowed ? 200 : 403);
          expect(writes).toBe(before + Number(allowed));
        }
      }
    }
  } finally {
    verify.mockRestore();
  }
});

test("read-only POST declarations survive nested mounts and custom error handlers", async () => {
  const verify = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", user, scopes: ["read"], payload: {} });
  try {
    const queries = new Hono<AuthContext>()
      .onError((_error, c) => c.text("failed", 500))
      .post("/:id/query", auth.readOnly, (c) => c.text("query"))
      .post("/:id/write", (c) => c.text("write"));
    const nested = new Hono<AuthContext>().onError((_error, c) => c.text("failed", 500)).route("/items", queries);
    const app = new Hono<AuthContext>().use(auth.requireRole("authenticated")).use(auth.requireUser()).route("/api", nested);
    expect((await app.request("/api/items/one/query", { method: "POST", headers })).status).toBe(200);
    expect((await app.request("/api/items/one/write", { method: "POST", headers })).status).toBe(403);
    verify.mockResolvedValue({ kind: "user", user, scopes: [], payload: {} });
    expect((await app.request("/api/items/one/query", { method: "POST", headers })).status).toBe(403);
  } finally {
    verify.mockRestore();
  }
});

test("a read-only declaration on a wildcard or use mount cannot exempt mutations", async () => {
  const verify = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", user, scopes: ["read"], payload: {} });
  try {
    for (const route of [
      new Hono<AuthContext>().use(auth.readOnly).post("/write", (c) => c.text("write")),
      new Hono<AuthContext>().post("/*", auth.readOnly, (c) => c.text("write")),
    ]) {
      const app = new Hono<AuthContext>().use(auth.requireRole("authenticated")).route("/", route);
      expect((await app.request("/write", { method: "POST", headers })).status).toBe(403);
    }
  } finally {
    verify.mockRestore();
  }
});

test("a read-only declaration never grants resource access", async () => {
  const verify = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", user, scopes: ["read"], payload: {} });
  try {
    const app = new Hono<AuthContext>().use(auth.requireRole("admin")).post("/preview", auth.readOnly, (c) => c.text("preview"));
    expect((await app.request("/preview", { method: "POST", headers })).status).toBe(403);
  } finally {
    verify.mockRestore();
  }
});

test("a read-only declaration cannot exempt an earlier or overlapping mutation", async () => {
  const verify = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", user, scopes: ["read"], payload: {} });
  try {
    for (const path of ["/query", "/:id"]) {
      let writes = 0;
      const app = new Hono<AuthContext>()
        .use(auth.requireRole("authenticated"))
        .post(path, (c) => {
          writes++;
          return c.text("write");
        })
        .post("/query", auth.readOnly, (c) => c.text("read"));
      expect((await app.request("/query", { method: "POST", headers })).status).toBe(403);
      expect(writes).toBe(0);
    }
  } finally {
    verify.mockRestore();
  }
});

test("an ALL handler cannot borrow a later read-only declaration", async () => {
  const verify = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", user, scopes: ["read"], payload: {} });
  try {
    for (const path of ["/query", "/:id", "/*"]) {
      let writes = 0;
      const app = new Hono<AuthContext>()
        .use(auth.requireRole("authenticated"))
        .all(path, (c) => {
          writes++;
          return c.text("write");
        })
        .post("/query", auth.readOnly, (c) => c.text("read"));
      expect((await app.request("/query", { method: "POST", headers })).status).toBe(403);
      expect(writes).toBe(0);
    }
  } finally {
    verify.mockRestore();
  }
});

test("explicit read-only middleware permits queries without exempting mutations", async () => {
  const verify = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", user, scopes: ["read"], payload: {} });
  try {
    const app = new Hono<AuthContext>()
      .use(auth.requireRole("authenticated"))
      .use(
        auth.readOnlyMiddleware(async (c, next) => {
          c.header("Cache-Control", "no-store");
          await next();
        }),
      )
      .post("/query", auth.readOnly, (c) => c.text("read"))
      .post("/write", (c) => c.text("write"));
    expect((await app.request("/query", { method: "POST", headers })).status).toBe(200);
    expect((await app.request("/write", { method: "POST", headers })).status).toBe(403);
    const unmarked = new Hono<AuthContext>()
      .use(auth.requireRole("authenticated"))
      .use(async (_c, next) => next())
      .post("/query", auth.readOnly, (c) => c.text("read"));
    expect((await unmarked.request("/query", { method: "POST", headers })).status).toBe(403);
  } finally {
    verify.mockRestore();
  }
});

test("a read-only declaration cannot exempt an ALL handler interleaved before its endpoint", async () => {
  const verify = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", user, scopes: ["read"], payload: {} });
  try {
    let writes = 0;
    const app = new Hono<AuthContext>()
      .use(auth.requireRole("authenticated"))
      .post("/query", auth.readOnly, async (_c, next) => next())
      .all("/*", (c) => {
        writes++;
        return c.text("write");
      })
      .post("/query", (c) => c.text("read"));
    expect((await app.request("/query", { method: "POST", headers })).status).toBe(403);
    expect(writes).toBe(0);
  } finally {
    verify.mockRestore();
  }
});

test("a terminal read-only endpoint keeps later catch-all routing unreachable", async () => {
  const verify = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", user, scopes: ["read"], payload: {} });
  try {
    let fallthrough = 0;
    const app = new Hono<AuthContext>()
      .use(auth.requireRole("authenticated"))
      .post("/query", auth.readOnly, (c) => c.text("read"))
      .all("/*", (c) => {
        fallthrough++;
        return c.text("fallback");
      });
    expect((await app.request("/query", { method: "POST", headers })).status).toBe(200);
    expect(fallthrough).toBe(0);
  } finally {
    verify.mockRestore();
  }
});
