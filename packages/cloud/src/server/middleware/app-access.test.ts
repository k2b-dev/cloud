import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { WSContext } from "hono/ws";
import { person } from "../../_internal/define-app.test-fixture";
import * as registry from "../../_internal/registry";
import { appAccess } from "../../contracts/app-access";
import { appAccessRevalidator, appPublicRouteMatcher, guardAppAccessSocket, requireAppAccess, watchAppAccess } from "./app-access";
import type { AuthContext, RequestAuthority } from "./auth";
import { auth } from "./auth";

const authority = (): RequestAuthority => ({
  actor: { kind: "user", user: person },
  accessSubject: { type: "user", userId: person.id },
  credentialKind: "session",
  scopes: [],
});
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const authenticate = (current: () => RequestAuthority | null) => {
  const spy = spyOn(auth, "requireRole").mockImplementation(() => async (c, next) => {
    const value = current();
    if (value) {
      c.set("actor", value.actor);
      c.set("accessSubject", value.accessSubject);
      c.set("credentialKind", value.credentialKind);
      c.set("credentialScopes", value.scopes);
      c.set("sessionToken", "same-session");
      c.set("sessionKind", "web");
    }
    await next();
  });
  spies.push(spy);
};

const renderDenied = async (_c: unknown, message: string) =>
  new Response(`<p>${message}</p>`, { status: 403, headers: { "content-type": "text/html" } });

describe("application entry gate", () => {
  test("denies API, SSR, CLI, OpenAPI, Help and WebSocket requests before application code", async () => {
    authenticate(authority);
    let calls = 0;
    const app = new Hono<AuthContext>()
      .use(requireAppAccess({ id: "restricted", name: "Restricted", access: appAccess.roles(["admin"]) }, renderDenied))
      .all("*", (c) => {
        calls++;
        return c.text("private application content");
      });
    for (const path of ["/api/private", "/cli/plugins/demo/module.js", "/openapi.json", "/help", "/ws"]) {
      const response = await app.request(path, { headers: path === "/ws" ? { upgrade: "websocket" } : {} });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "app_access_denied",
        app: "restricted",
        message: expect.stringContaining("administrator"),
      });
    }
    const page = await app.request("/page", { headers: { accept: "text/html" } });
    expect(page.status).toBe(403);
    expect(await page.text()).not.toContain("private application content");
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect(calls).toBe(0);
  });

  test("retains legacy behavior and bypasses only declared public path patterns", async () => {
    let authCalls = 0;
    authenticate(() => {
      authCalls++;
      return null;
    });
    for (const access of [undefined, appAccess.roles(["admin"], { publicRoutes: ["/share/:token", "/webhook/*"] })]) {
      const app = new Hono<AuthContext>()
        .use(requireAppAccess({ id: "demo", access }, renderDenied))
        .all("*", (c) => c.text("route still runs its own auth"));
      expect((await app.request("/share/one")).status).toBe(200);
      expect((await app.request("/webhook/update")).status).toBe(200);
    }
    expect(authCalls).toBe(0);
    const match = appPublicRouteMatcher({ id: "demo", access: appAccess.signedIn({ publicRoutes: ["/share/:token"] }) });
    expect(match("/share/token")).toBe(true);
    expect(match("/share/token/private")).toBe(false);
    expect(match("/shared/token")).toBe(false);
  });

  test("anonymous protected documents retain login returnTo, APIs return 401 and mobile launch stops retry loops", async () => {
    authenticate(() => null);
    const app = new Hono<AuthContext>()
      .use(requireAppAccess({ id: "demo", access: appAccess.signedIn() }, renderDenied))
      .all("*", (c) => c.text("private"));
    expect((await app.request("/api/private")).status).toBe(401);
    const page = await app.request("/page?item=one", { headers: { accept: "text/html" } });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toContain("redirectTo=");
    expect((await app.request("/pwa/demo?pwa_launch=1", { headers: { accept: "text/html" } })).headers.get("location")).toBe(
      "/pwa/?pwa=unavailable",
    );
  });

  test("declared public routes still run their own auth policy", async () => {
    const app = new Hono<AuthContext>()
      .use(requireAppAccess({ id: "demo", access: appAccess.signedIn({ publicRoutes: ["/callback"] }) }, renderDenied))
      .get("/callback", (c) => c.json({ code: "special_auth_required" }, 401));
    expect(await (await app.request("/callback")).json()).toEqual({ code: "special_auth_required" });
  });
});

describe("live app authority", () => {
  test("reloads current roles rather than reusing the handshake actor", async () => {
    let current = authority();
    current.actor = { kind: "user", user: { ...person, roles: ["admin"] } };
    authenticate(() => current);
    let revalidate: () => Promise<boolean> = async () => false;
    const app = new Hono<AuthContext>().use(auth.requireRole("*")).get("/ws", (c) => {
      revalidate = appAccessRevalidator(c, { id: "demo", access: appAccess.roles(["admin"]) });
      return c.text("ok");
    });
    await app.request("/ws");
    expect(await revalidate()).toBe(true);
    current = authority();
    expect(await revalidate()).toBe(false);
  });

  test("unknown socket applications fail closed without opening app handlers", async () => {
    spies.push(spyOn(registry, "getApp").mockResolvedValue(null));
    let opened = false;
    const app = new Hono<AuthContext>().get("/", async (c) => {
      const events = await guardAppAccessSocket(c, "unknown", {
        onOpen: () => {
          opened = true;
        },
      });
      let reason = "";
      events.onOpen?.(
        new Event("open"),
        new WSContext({
          readyState: 1,
          close: (_code, text) => {
            reason = text ?? "";
          },
          send: () => {},
        }),
      );
      return c.text(reason);
    });
    expect(await (await app.request("/")).text()).toBe("app_access_denied");
    expect(opened).toBe(false);
  });
});

describe("bounded app access watcher", () => {
  test("coalesces invalidations and releases its subscription after revocation", async () => {
    let invalidated = () => {};
    let resolve: ((allowed: boolean) => void) | undefined;
    let calls = 0,
      closed = 0,
      released = 0;
    const stop = watchAppAccess({
      check: () => {
        calls++;
        return new Promise<boolean>((done) => {
          resolve = done;
        });
      },
      subscribe: (changed) => {
        invalidated = changed;
        return () => {
          released++;
        };
      },
      denied: () => {
        closed++;
      },
      intervalMs: 1000,
      timeoutMs: 1000,
    });
    try {
      invalidated();
      invalidated();
      expect(calls).toBe(1);
      resolve?.(true);
      await Bun.sleep(0);
      expect(calls).toBe(2);
      resolve?.(false);
      await Bun.sleep(0);
      expect(closed).toBe(1);
      expect(released).toBe(1);
      invalidated();
      expect(calls).toBe(2);
    } finally {
      stop();
    }
  });

  test("failure and timeout close the connection, and explicit teardown cancels the deadline", async () => {
    for (const kind of ["reject", "timeout", "teardown"] as const) {
      let closed = 0,
        released = 0;
      const stop = watchAppAccess({
        check: () => (kind === "reject" ? Promise.reject(new Error("database unavailable")) : new Promise(() => {})),
        subscribe: () => () => {
          released++;
        },
        denied: () => {
          closed++;
        },
        intervalMs: 50,
        timeoutMs: 5,
      });
      if (kind === "teardown") stop();
      await Bun.sleep(15);
      expect(closed).toBe(kind === "teardown" ? 0 : 1);
      expect(released).toBe(1);
      stop();
    }
  });
});
