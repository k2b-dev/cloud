import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeAppMeta, User } from "@k2b/cloud/contracts";
import { coreSettings, pwaDevices } from "@k2b/cloud/services";
import { announcements } from "@k2b/cloud/services/announcements";
import * as iconSource from "@k2b/cloud/services/branding/app-icon-source";
import { session } from "@k2b/cloud/services/session";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import serviceWorkerSource from "./service-worker.js" with { type: "text" };

const root = mkdtempSync(join(tmpdir(), "pwa-shell-routes-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { shellRoutes } = await import("./index");

/** Invented demo account and phone. */
const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "mmuster",
  provider: "local",
  profile: "user",
  roles: ["user", "local", "local/user"],
  givenname: "Mia",
  sn: "Muster",
  displayName: "Mia Muster",
  mail: "mia.muster@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const shell: RuntimeAppMeta = {
  id: "pwa",
  name: "Mobile app",
  icon: "ti ti-device-mobile",
  description: "",
  routes: ["/pwa", "/public/pwa"],
};
const inventory: RuntimeAppMeta = {
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-box",
  description: "Count what is on the shelf",
  routes: ["/pwa/inventory"],
  pwa: { href: "/pwa/inventory" },
};
let apps: RuntimeAppMeta[] = [shell];
let settings: Record<string, string> = { "app.name": "Example Cloud", "app.locale": "de", "app.logo": "" };

const spies = [
  stubRailSnapshot(),
  spyOn(session, "getToken").mockReturnValue(null),
  spyOn(session, "authenticateRequest").mockResolvedValue(null),
  spyOn(announcements.active, "forState").mockResolvedValue({ banners: [], announcements: [], latestAnnouncementVersion: 0 }),
  spyOn(coreSettings, "get").mockImplementation((async (key: string) => settings[key]) as never),
  spyOn(iconSource, "appIconVersion").mockImplementation(async () => (settings["app.logo"] ? "bbbbbbbbbbbb" : "aaaaaaaaaaaa")),
  spyOn(iconSource, "readAppIconSource").mockImplementation(async () => ({
    data: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    mime: "image/svg+xml",
    version: "aaaaaaaaaaaa",
  })),
  spyOn(pwaDevices, "current").mockResolvedValue({
    id: "22222222-2222-4222-8222-222222222222",
    name: "iPhone",
    platform: "ios",
    createdAt: "2026-09-01T10:00:00.000Z",
    lastUsedAt: "2026-10-01T10:00:00.000Z",
    current: true,
  }),
];
const [, tokenSpy, sessionSpy] = spies as unknown as [unknown, ReturnType<typeof spyOn>, ReturnType<typeof spyOn>];
afterEach(() => {
  apps = [shell];
  settings = { "app.name": "Example Cloud", "app.locale": "de", "app.logo": "" };
  tokenSpy.mockReturnValue(null);
  sessionSpy.mockResolvedValue(null);
});
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

const signIn = (kind: "app" | "web" = "app") => {
  tokenSpy.mockReturnValue("test-session");
  sessionSpy.mockResolvedValue({
    user,
    data: { userId: user.id, sid: "test", authEpoch: 0, kind, expiresAt: "2099-01-01T00:00:00Z" },
  });
};

const server = new Hono()
  .use("*", async (c, next) => {
    c.set("runtime" as never, { apps } as never);
    c.set("settings" as never, { app: { name: settings["app.name"], locale: settings["app.locale"] } } as never);
    await next();
  })
  .route("/", shellRoutes);
const request = (path: string, init: RequestInit = {}) =>
  server.request(`https://cloud.example.test${path}`, { ...init, headers: { Cookie: "pwa_session=test-session", ...init.headers } });

describe("shell routes", () => {
  test("/pwa leaves for the scope, which only /pwa/ is", async () => {
    const response = await request("/pwa");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/pwa/");
  });

  test("/pwa/ without an app session goes through Core's launch bounce, and the bounce's marker stops a loop", async () => {
    let response = await request("/pwa/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/pwa/_auth/session/launch?to=%2Fpwa%2F");
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    response = await request("/pwa/?pwa_launch=1", { headers: { Cookie: "cloud.locale=en" } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Can't reach Example Cloud right now.");
  });

  test("a web session never opens Start", async () => {
    signIn("web");
    const response = await request("/pwa/", { headers: { Cookie: "session_token=test-session" } });
    expect(response.status).toBe(302);
  });

  for (const [state, text] of [
    ["new", "Pair this app with your account on the web."],
    ["ended", "This phone was signed out. Connect it again."],
    ["expired", "This code expired. Get a new one on the web."],
    ["blocked", "This account can't use the app right now."],
    ["unavailable", "Can't reach Example Cloud right now."],
  ] as const)
    test(`/pwa/?pwa=${state} shows that state without an app session`, async () => {
      const response = await request(`/pwa/?pwa=${state}`, { headers: { "Accept-Language": "en", Cookie: "cloud.locale=en" } });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(text);
      expect(html).toContain('<link rel="manifest" href="/pwa/manifest.webmanifest">');
      expect(html).not.toContain("k2b-tab-bar");
      if (state === "new" || state === "ended" || state === "expired") {
        // Both blocks render on the server; the display mode picks one.
        expect(html).toContain("pwa-standalone-only");
        expect(html).toContain("pwa-browser-only");
        expect(html).toContain("/branding/pwa-icon-192.png?v=aaaaaaaaaaaa");
      }
    });

  test("Start lists the parts and Settings, and shows a calm empty state without parts", async () => {
    signIn();
    let html = await (await request("/pwa/", { headers: { Cookie: "pwa_session=test-session; cloud.locale=en" } })).text();
    expect(html).toContain("No apps for your phone yet.");
    expect(html).toContain('href="/pwa/settings"');
    expect(html).toContain("<title>Example Cloud</title>");

    apps = [shell, inventory];
    html = await (await request("/pwa/", { headers: { Cookie: "pwa_session=test-session; cloud.locale=en" } })).text();
    expect(html).not.toContain("No apps for your phone yet.");
    expect(html).toContain('href="/pwa/inventory"');
    expect(html).toContain("Count what is on the shelf");
    expect(html).toContain("k2b-tab-bar");
  });

  test("Settings needs an app session and shows the account, this phone and the version", async () => {
    const anonymous = await request("/pwa/settings");
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("location")).toBe("/pwa/_auth/session/launch?to=%2Fpwa%2Fsettings");

    signIn();
    const response = await request("/pwa/settings", { headers: { Cookie: "pwa_session=test-session; cloud.locale=en" } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Mia Muster");
    expect(html).toContain("mia.muster@example.test");
    expect(html).toContain("&quot;iPhone&quot;");
    expect(html).toMatch(/Cloud \d+\.\d+\.\d+/);
    expect(html).toContain('href="/pwa/"');
  });

  test("unknown shell pages answer the app's 404", async () => {
    const response = await request("/pwa/nothing-here", { headers: { Cookie: "cloud.locale=en" } });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("k2b-mobile-shell");
  });

  test("every shell page refuses framing and referrers", async () => {
    for (const path of ["/pwa/?pwa=new", "/pwa/?pwa=unavailable", "/pwa/nothing-here"]) {
      const response = await request(path);
      expect([path, response.headers.get("referrer-policy"), response.headers.get("content-security-policy")]).toEqual([
        path,
        "no-referrer",
        "frame-ancestors 'none'",
      ]);
    }
  });
});

describe("manifest", () => {
  test("describes the installation's app at /pwa/ with versioned icons and validators", async () => {
    const response = await request("/pwa/manifest.webmanifest");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/manifest+json");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.json()).toEqual({
      id: "/pwa/",
      name: "Example Cloud",
      short_name: "Example Cloud",
      start_url: "/pwa/",
      scope: "/pwa/",
      display: "standalone",
      background_color: "#fafafa",
      theme_color: "#fafafa",
      lang: "de",
      icons: [
        { src: "/branding/pwa-icon-192.png?v=aaaaaaaaaaaa", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/branding/pwa-icon-512.png?v=aaaaaaaaaaaa", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/branding/pwa-icon-maskable-512.png?v=aaaaaaaaaaaa", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    });
    const etag = response.headers.get("etag")!;
    expect((await request("/pwa/manifest.webmanifest", { headers: { "If-None-Match": etag } })).status).toBe(304);

    settings["app.logo"] = "data:image/png;base64,AAAA";
    const changed = await request("/pwa/manifest.webmanifest", { headers: { "If-None-Match": etag } });
    expect(changed.status).toBe(200);
    expect(JSON.stringify(await changed.json())).toContain("?v=bbbbbbbbbbbb");
  });
});

type Listener = (event: Record<string, unknown>) => void;

/** Runs the served worker against a fake service worker global, as Core tests its notification worker. */
const loadWorker = async (network: (request: Request) => Promise<Response>) => {
  const response = await request("/pwa/sw.js");
  const source = await response.text();
  const listeners = new Map<string, Listener>();
  const calls = { skipWaiting: 0, claim: 0 };
  // Every cache a page script could have written to; the worker must never read one.
  const caches = new Proxy(
    {},
    {
      get: () => {
        throw new Error("The worker read CacheStorage");
      },
    },
  );
  const worker = {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: async () => void calls.skipWaiting++,
    clients: { claim: async () => void calls.claim++ },
  };
  new Function("self", "caches", "fetch", "location", "Response", source)(
    worker,
    caches,
    network,
    { origin: "https://cloud.example.test" },
    Response,
  );
  const run = async (type: string, event: Record<string, unknown>) => {
    let done: Promise<unknown> | undefined;
    listeners.get(type)!({ ...event, waitUntil: (promise: Promise<unknown>) => (done = promise) });
    await done;
  };
  const navigate = async (url: string, mode = "navigate") => {
    let answer: Promise<Response> | undefined;
    listeners.get("fetch")!({ request: { url, mode }, respondWith: (promise: Promise<Response>) => (answer = promise) });
    return answer ? await answer : undefined;
  };
  const offlineHtml = JSON.parse(/^const OFFLINE_HTML = (".*");$/m.exec(source)![1]!) as string;
  return { response, source, offlineHtml, calls, run, navigate };
};

describe("service worker", () => {
  test("is served for the /pwa/ scope, changes with the installation name, and revalidates", async () => {
    const worker = await loadWorker(async () => new Response("page"));
    expect(worker.response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(worker.response.headers.get("cache-control")).toBe("no-cache");
    expect(worker.response.headers.get("service-worker-allowed")).toBeNull();
    expect(worker.source).toEndWith(serviceWorkerSource);
    const etag = worker.response.headers.get("etag")!;
    expect((await request("/pwa/sw.js", { headers: { "If-None-Match": etag } })).status).toBe(304);
    settings["app.name"] = "Another Cloud";
    const changed = await request("/pwa/sw.js", { headers: { "If-None-Match": etag } });
    expect(changed.status).toBe(200);
    expect(await changed.text()).not.toBe(worker.source);
  });

  test("caches nothing and takes over at once", async () => {
    const worker = await loadWorker(async () => new Response("page"));
    await worker.run("install", {});
    expect(worker.calls.skipWaiting).toBe(1);
    await worker.run("activate", {});
    expect(worker.calls.claim).toBe(1);
  });

  test("shows its own offline page for network errors, gateway errors and Core's 404 below /pwa/, and nothing else", async () => {
    let answer: () => Promise<Response> = async () => new Response("page");
    const worker = await loadWorker(() => answer());
    const offline = async (url: string) => {
      const response = (await worker.navigate(url))!;
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      return (await response.text()) === worker.offlineHtml;
    };

    expect(await (await worker.navigate("https://cloud.example.test/pwa/inventory"))!.text()).toBe("page");
    answer = async () => {
      throw new TypeError("offline");
    };
    expect(await offline("https://cloud.example.test/pwa/")).toBe(true);
    for (const status of [502, 503, 504]) {
      answer = async () => new Response("gateway", { status });
      expect(await offline("https://cloud.example.test/pwa/")).toBe(true);
    }
    answer = async () => new Response("core 404", { status: 404, headers: { "X-Gateway-App": "core" } });
    expect(await offline("https://cloud.example.test/pwa/")).toBe(true);
    // Core serves /pwa/_auth: a link there cannot call up the offline page.
    expect(await (await worker.navigate("https://cloud.example.test/pwa/_auth/anything"))!.text()).toBe("core 404");
    answer = async () => new Response("part 404", { status: 404, headers: { "X-Gateway-App": "inventory" } });
    expect(await (await worker.navigate("https://cloud.example.test/pwa/inventory/9"))!.text()).toBe("part 404");
    answer = async () => new Response("server error", { status: 500 });
    expect(await (await worker.navigate("https://cloud.example.test/pwa/"))!.text()).toBe("server error");

    // Never API responses, other requests, pages outside the app or other origins.
    expect(await worker.navigate("https://cloud.example.test/api/inventory/items", "cors")).toBeUndefined();
    expect(await worker.navigate("https://cloud.example.test/me/app")).toBeUndefined();
    expect(await worker.navigate("https://other.example.test/pwa/")).toBeUndefined();
  });
});

describe("offline page", () => {
  test("is self-contained, carries both languages and the inline logo, and nothing about the account", async () => {
    signIn();
    const { offlineHtml: html } = await loadWorker(async () => new Response("page"));
    expect(html).toContain("Can&#39;t reach Example Cloud");
    expect(html).toContain("Example Cloud nicht erreichbar");
    expect(html).toContain('src="data:image/svg+xml;base64,');
    expect(html).toContain("viewport-fit=cover");
    expect(html).toContain("env(safe-area-inset-top)");
    expect(html).not.toMatch(/<link|<script src|https?:\/\//);
    expect(html).not.toContain("Mia");
  });
});
