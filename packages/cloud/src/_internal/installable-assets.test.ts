import { describe, expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { Hono } from "hono";
import { kiosk } from "./installable.test-fixture";
import { createInstallableRoutes, installableManifest, installableOfflineHtml, installableWorker } from "./installable-assets";

describe("generated public App-PWA assets", () => {
  test("manifest identity stays neutral and stable across themes and two PWAs on one origin", () => {
    const second = { ...kiosk, path: "/app/orders/counter/" };
    for (const app of [kiosk, second])
      for (const theme of ["light", "dark"] as const) {
        const manifest = installableManifest(app, theme);
        expect([manifest.id, manifest.start_url, manifest.scope]).toEqual([app.path, app.path, app.path]);
        expect(manifest.theme_color).toBe(app.themeColor[theme]);
        expect(manifest.display).toBe("standalone");
        expect(manifest.icons.map((icon) => [icon.sizes, icon.purpose])).toEqual([
          ["192x192", "any"],
          ["512x512", "any"],
          ["512x512", "maskable"],
        ]);
        expect(manifest.icons.every((icon) => icon.src.startsWith(app.path) && icon.src.endsWith(`-${theme}.png`))).toBe(true);
      }
    expect(installableManifest(kiosk, "light").id).not.toBe(installableManifest(second, "light").id);
  });

  test("assets bypass downstream auth; missing icons and unsupported methods never fall through", async () => {
    const router = new Hono().route("/", createInstallableRoutes("inventory", kiosk, "/nonexistent-public"));
    router.all("*", (c) => c.text("private app", 401));
    for (const file of ["manifest.webmanifest", "sw.js", "offline.html"]) {
      const response = await router.request(`${kiosk.path}${file}`, { headers: { Cookie: "private=secret", "Accept-Language": "de" } });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
      expect(response.headers.has("Service-Worker-Allowed")).toBe(false);
      expect(await response.text()).not.toContain("secret");
      expect((await router.request(`${kiosk.path}${file}`, { method: "POST" })).status).toBe(405);
      expect(await (await router.request(`${kiosk.path}${file}`, { method: "HEAD" })).text()).toBe("");
    }
    expect((await router.request(`${kiosk.path}icon-192-light.png`)).status).toBe(404);
    expect((await router.request(kiosk.path)).status).toBe(401);
    const redirect = await router.request(kiosk.path.slice(0, -1) + "?view=counter");
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe(kiosk.path + "?view=counter");
    expect(installableOfflineHtml(kiosk)).toContain("Erneut versuchen");
  });

  test("worker only handles scoped GET navigations: network first, neutral offline, no private caches or mid-session activation", async () => {
    const handlers = new Map<string, (event: { request: Request; respondWith: (response: Promise<Response>) => void }) => void>();
    let online = true;
    const network: string[] = [];
    const sandbox = createContext({
      URL,
      Response,
      self: {
        location: { origin: "https://cloud.test" },
        addEventListener: (
          name: string,
          handler: (event: { request: Request; respondWith: (response: Promise<Response>) => void }) => void,
        ) => handlers.set(name, handler),
      },
      fetch: async (request: Request) => {
        network.push(request.url);
        if (!online) throw new Error("offline");
        return new Response("private document");
      },
      // No caches, storage, skipWaiting, clients.claim or postMessage globals: any use fails this executable test.
    });
    const source = installableWorker(kiosk);
    runInContext(source, sandbox);
    expect([...handlers.keys()]).toEqual(["fetch"]);
    for (const forbidden of ["skipWaiting", "clients.claim", "caches.", "localStorage", "indexedDB", "postMessage"])
      expect(source).not.toContain(forbidden);
    const dispatch = (path: string, mode = "navigate", method = "GET") => {
      let response: Promise<Response> | undefined;
      const request = new Request(new URL(path, "https://cloud.test"), { method });
      Object.defineProperty(request, "mode", { value: mode });
      handlers.get("fetch")!({
        request,
        respondWith: (result) => {
          response = result;
        },
      });
      return response;
    };
    expect(await (await dispatch(kiosk.path + "documents/123?private=token"))!.text()).toBe("private document");
    online = false;
    const offline = await dispatch(kiosk.path + "documents/123?private=token");
    expect(offline?.status).toBe(503);
    const html = await offline!.text();
    expect(html).toBe(installableOfflineHtml(kiosk));
    expect(html).not.toMatch(/private|token|123/);
    expect(offline?.headers.get("cache-control")).toBe("no-store");
    for (const [path, mode, method] of [
      [kiosk.path + "documents/123", "navigate", "POST"],
      [kiosk.path + "api", "cors", "GET"],
      ["/api/inventory/documents", "cors", "GET"],
      ["/app/orders/counter/", "navigate", "GET"],
      ["/app/inventory/counterfeit/", "navigate", "GET"],
      ["https://other.test" + kiosk.path, "navigate", "GET"],
    ])
      expect(dispatch(path!, mode, method)).toBeUndefined();
    expect(network).toHaveLength(2);
  });
});
