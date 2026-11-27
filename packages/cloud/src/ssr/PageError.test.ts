import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { User } from "../contracts/shared";
import { type AuthContext, auth } from "../server/middleware/auth";
import { announcements } from "../services/announcements";
import { serviceAccountCredentials } from "../services/service-account-credentials";
import { session } from "../services/session";
import { pageErrorMessages } from "./page-error-messages";
import type { RuntimeContext } from "./runtime";

const root = mkdtempSync(join(tmpdir(), "cloud-page-errors-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { defineApp } = await import("../_internal/define-app");
const { ssr } = defineApp({
  id: "page-errors-test",
  name: "Test",
  icon: "ti ti-test-pipe",
  description: "Page errors",
  baseUrl: "http://test:3000",
  routes: ["/app/test"],
});

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "test",
  provider: "local",
  profile: "user",
  roles: ["user", "local", "local/user"],
  givenname: "Test",
  sn: "User",
  displayName: "Test User",
  mail: "test@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const tokenSpy = spyOn(session, "getToken").mockReturnValue(null);
const sessionSpy = spyOn(session, "authenticateRequest").mockResolvedValue(null);
afterEach(() => {
  tokenSpy.mockReturnValue(null);
  sessionSpy.mockResolvedValue(null);
});
afterAll(() => {
  tokenSpy.mockRestore();
  sessionSpy.mockRestore();
});

const signIn = (account: User = user) => {
  tokenSpy.mockReturnValue("test-session");
  sessionSpy.mockResolvedValue({
    user: account,
    data: { userId: account.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
  });
};

const server = new Hono<AuthContext & { Variables: { runtime: RuntimeContext } }>()
  .use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  })
  .get("/admin", auth.requireRole("admin", ssr.access), (c) => c.text("authorized handler"))
  .get("/user", auth.requireRole("user", ssr.access), (c) => c.text("authorized handler"))
  .get("/account", auth.requireAccount({ provider: "ipa", profile: "user", ...ssr.access }), (c) => c.text("authorized handler"))
  .get("/api/admin", auth.requireRole("admin"), (c) => c.json({ ok: true }))
  .get("/nested/missing", auth.requireRole("*"), (c) => ssr.error(c, 404))
  .get("/minimal", (c) => ssr.error(c, 404, { layout: "minimal" }))
  .get("/service-error", (c) => ssr.error(c, 503))
  .get("/busy", (c) =>
    ssr.error(c, 503, { title: "Busy", description: "Later.", action: { label: "Try again", href: "/busy?again=1", icon: "refresh" } }),
  )
  .get("/minimal-busy", (c) => ssr.error(c, 503, { layout: "minimal", action: { label: "Again", href: "/minimal-busy", icon: "refresh" } }))
  .get("/admin/missing", (c) => ssr.error(c, 404))
  .get("/app/test/item", (c) => ssr.error(c, 404, { action: { label: "Back to items", href: "/app/test" } }))
  .get("/unsafe", (c) => ssr.error(c, 404, { title: "</title><script>bad()</script>", description: "<img src=x onerror=bad()>" }))
  .get(
    "/status",
    ...ssr((c) => {
      c.header("Referrer-Policy", "no-referrer");
      return ssr.error(c, 403);
    }),
  )
  .get("/resource", auth.requireRole("authenticated", ssr.access), (c) => ssr.error(c, 403))
  .get("/self", auth.requireRole("authenticated", ssr.access), auth.requireUser(ssr.access), (c) => c.text("authorized handler"))
  .post("/action", auth.requireRole("admin", ssr.access), (c) => c.text("action executed"))
  .get("*", (c) => ssr.error(c, 503));

describe("shared page access and error responses", () => {
  test("signed-in error pages retain shared announcements", async () => {
    signIn();
    const now = new Date().toISOString();
    const active = spyOn(announcements.active, "forState").mockResolvedValue({
      banners: [
        {
          id: crypto.randomUUID(),
          version: 1,
          kind: "banner",
          title: "Error page announcement",
          bodyHtml: "Visible banner",
          tone: "info",
          publishedAt: now,
          expiresAt: null,
          createdAt: now,
          updatedAt: now,
          createdBy: null,
          updatedBy: null,
        },
      ],
      announcements: [],
      latestAnnouncementVersion: 0,
    });
    try {
      for (const path of ["/admin", "/nested/missing"]) {
        const response = await server.request(path, { headers: { Cookie: "session_token=test-session" } });
        expect(response.status).toBe(path === "/admin" ? 403 : 404);
        expect(await response.text()).toContain("Error page announcement");
      }
      expect(active).toHaveBeenCalledTimes(2);
    } finally {
      active.mockRestore();
    }
  });
  test("catalog is complete", () => expect(pageErrorMessages.check()).toEqual([]));
  for (const path of ["/admin?tab=details", "/user", "/account", "/resource"]) {
    test(`anonymous ${path} retains its login return path`, async () => {
      const response = await server.request(path);
      expect(response.status).toBe(302);
      const redirect = new URL(response.headers.get("location")!, "https://cloud.test");
      expect(redirect.pathname).toBe("/auth/login");
      expect(redirect.searchParams.get("redirectTo")).toBe(path);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    });
  }
  test("expired session follows the same login path", async () => {
    tokenSpy.mockReturnValue("expired-session");
    const response = await server.request("/admin");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/auth/login?redirectTo=%2Fadmin");
  });
  for (const locale of ["en", "de-CH"])
    for (const theme of ["light", "dark"]) {
      test(`forbidden page is localized HTML, ${locale}, ${theme}`, async () => {
        signIn();
        const response = await server.request("/admin", { headers: { "Accept-Language": locale, Cookie: `theme=${theme}` } });
        const body = await response.text();
        expect(response.status).toBe(403);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(response.headers.get("location")).toBeNull();
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(body).toContain(`lang="${locale}" class="${theme}"`);
        expect(body).toContain(locale === "en" ? "have access to this" : "Dafür fehlt dir der Zugriff");
        // the Cloud shell's error page is a v2 screen (approved direction A): the code large, title, sentence, ways out
        expect(body).toContain('data-k2-part="ErrorScreen"');
        expect(body).not.toContain("authorized handler");
        expect(body).not.toContain("admin-sidebar");
      });
    }
  test("allowed users and admins reach the handler", async () => {
    signIn();
    expect(await (await server.request("/user")).text()).toBe("authorized handler");
    signIn({ ...user, roles: [...user.roles, "admin"] });
    expect(await (await server.request("/admin")).text()).toBe("authorized handler");
  });
  test("guest profile and provider mismatch render 403 instead of a login loop", async () => {
    signIn({ ...user, profile: "guest", roles: ["guest", "local", "local/guest"] });
    expect((await server.request("/user")).status).toBe(403);
    signIn();
    const response = await server.request("/account");
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
  });
  test("API responses are still JSON 401/403", async () => {
    expect((await server.request("/api/admin")).status).toBe(401);
    signIn();
    const response = await server.request("/api/admin");
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ message: "Insufficient permissions" });
  });
  test("resource-bound actors receive HTML 403 on user-backed pages", async () => {
    const accountId = "22222222-2222-4222-8222-222222222222";
    const authenticate = spyOn(serviceAccountCredentials, "authenticateApiToken").mockResolvedValue({
      serviceAccount: {
        id: accountId,
        name: "Test",
        kind: "resource_bound",
        status: "active",
        delegatedUserId: null,
        appId: "test",
        resourceType: "cloud.app",
        resourceId: "test",
        createdBy: null,
        createdAt: "2026-09-01T00:00:00Z",
      },
      credential: {
        id: "33333333-3333-4333-8333-333333333333",
        serviceAccountId: accountId,
        name: "Test",
        kind: "api_token",
        status: "active",
        tokenPrefix: "0123456789abcdef01234567",
        scopes: ["read"],
        expiresAt: null,
        lastUsedAt: null,
        createdBy: null,
        createdAt: "2026-09-01T00:00:00Z",
        revokedAt: null,
        revokedBy: null,
      },
      delegatedUser: null,
    });
    try {
      for (const path of ["/self", "/account"]) {
        const response = await server.request(path, {
          headers: {
            authorization: "Bearer cld_0123456789abcdef01234567_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          },
        });
        expect(response.status).toBe(403);
        expect(response.headers.get("location")).toBeNull();
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(await response.text()).not.toContain("authorized handler");
      }
    } finally {
      authenticate.mockRestore();
    }
  });
  test("missing and standalone pages render 404 without a login redirect", async () => {
    const response = await server.request("/nested/missing");
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("This page does not exist");
    const minimal = await server.request("/minimal");
    const body = await minimal.text();
    expect(minimal.status).toBe(404);
    expect(body).toContain("minimal-layout-footer");
    expect(body).not.toContain("layout-header");
  });
  test("error responses returned inside SSR retain security headers", async () => {
    const response = await server.request("/status");
    expect(response.status).toBe(403);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-type")).toContain("text/html");
  });
  test("custom titles and descriptions cannot inject HTML", async () => {
    const body = await (await server.request("/unsafe")).text();
    expect(body).not.toContain("<script>bad()</script>");
    expect(body).not.toContain("<img src=x onerror=bad()>");
    expect(body).toContain("&lt;");
  });
  test("other service failures retain their status instead of becoming missing or forbidden", async () => {
    const response = await server.request("/service-error");
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toContain("503");
  });
  test("only the generic not-found and server-failure pages show the waiting game", async () => {
    const offered = async (path: string, init?: RequestInit) => {
      const body = await (await server.request(path, init)).text();
      // On a v2 page the game is an invitation at the foot of the error screen and opens over it when asked; on the
      // minimal page (v1 until #4227) the scene's box is part of the first paint, so nothing moves when its code arrives.
      const invited = body.includes('class="k2-es-foot"');
      const boxed = body.includes("data-waiting-game>") && body.includes("h-[clamp(20rem,52vh,32rem)]");
      return invited || boxed;
    };
    expect(await offered("/nested/missing")).toBe(true);
    expect(await offered("/minimal")).toBe(true);
    expect(await offered("/service-error")).toBe(true);
    // Never where the person has a problem to solve: access denied, an app's own error, administration.
    signIn();
    expect(await offered("/admin", { headers: { Cookie: "session_token=test-session" } })).toBe(false);
    expect(await offered("/resource", { headers: { Cookie: "session_token=test-session" } })).toBe(false);
    expect(await offered("/unsafe")).toBe(false);
    expect(await offered("/app/test/item")).toBe(false);
    expect(await offered("/admin/missing")).toBe(false);
  });
  test("a failed page whose own way out only loads it again offers it once and home second", async () => {
    const body = await (await server.request("/busy")).text();
    expect(body.split("Try again").length - 1).toBe(1);
    expect(body).toContain(`href="/busy"`);
    expect(body).toContain(`href="/"`);
  });
  test("the action's icon is a Tabler name without the prefix, on the v2 and the minimal page", async () => {
    const v2 = await (await server.request("/busy")).text();
    const minimal = await (await server.request("/minimal-busy")).text();
    for (const body of [v2, minimal]) {
      expect(body).toContain("ti ti-refresh");
      expect(body).not.toContain("ti-ti-");
    }
  });
  test("the retry link never becomes a protocol-relative address", async () => {
    const body = await (await server.request("http://localhost//elsewhere.example/a?b=1")).text();
    expect(body).not.toContain(`href="//`);
    expect(body).toContain(`href="/elsewhere.example/a?b=1"`);
  });
  test("denied POST actions never execute or replay effects", async () => {
    expect((await server.request("/action", { method: "POST" })).status).toBe(302);
    signIn();
    const response = await server.request("/action", { method: "POST" });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("action executed");
  });
});
