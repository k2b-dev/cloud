import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { RuntimeAppMeta } from "../contracts/app";
import type { User } from "../contracts/shared";
import { type AuthContext, auth } from "../server/middleware/auth";
import { announcements } from "../services/announcements";
import { session } from "../services/session";
import { pwaMessages } from "./pwa-messages";
import type { RuntimeContext } from "./runtime";

const root = mkdtempSync(join(tmpdir(), "cloud-pwa-layout-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { defineApp } = await import("../_internal/define-app");
const { default: PwaLayout } = await import("./PwaLayout");
const { useLocale } = await import("@k2b/ui");
const { ssr } = defineApp({
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-box",
  description: "Invented test part",
  baseUrl: "http://inventory:3000",
  routes: [],
  pwa: {},
});

/** Invented demo account. */
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

const part = (id: string, name: string, extra: Partial<RuntimeAppMeta> = {}): RuntimeAppMeta => ({
  id,
  name,
  icon: `ti ti-${id}`,
  description: `${name} on the phone`,
  routes: [`/pwa/${id}`],
  pwa: { href: `/pwa/${id}` },
  ...extra,
});
const shell: RuntimeAppMeta = { id: "pwa", name: "Mobile app", icon: "ti ti-device-mobile", description: "", routes: ["/pwa"] };
let apps: RuntimeAppMeta[] = [];

const tokenSpy = spyOn(session, "getToken").mockReturnValue(null);
const sessionSpy = spyOn(session, "authenticateRequest").mockResolvedValue(null);
const railSnapshot = stubRailSnapshot();
const announcementSpy = spyOn(announcements.active, "forState").mockResolvedValue({
  banners: [],
  announcements: [],
  latestAnnouncementVersion: 0,
});
afterEach(() => {
  tokenSpy.mockReturnValue(null);
  sessionSpy.mockResolvedValue(null);
});
afterAll(() => {
  tokenSpy.mockRestore();
  sessionSpy.mockRestore();
  announcementSpy.mockRestore();
  railSnapshot.mockRestore();
});

const signIn = (kind: "app" | "web", account: User = user) => {
  tokenSpy.mockReturnValue("test-session");
  sessionSpy.mockResolvedValue({
    user: account,
    data: { userId: account.id, sid: "test", authEpoch: 0, kind, expiresAt: "2099-01-01T00:00:00Z" },
  });
};

/** Echoes the inherited `LocaleProvider` locale. JSX in this file is not compiled for Solid; components are built directly. */
const LocaleEcho = () => {
  const locale = useLocale();
  return `[[locale:${locale()}]]`;
};

const page = ssr<AuthContext>(
  (c) => () =>
    createComponent(PwaLayout, {
      c,
      title: c.req.query("title") ?? "Items",
      back: c.req.query("back") ? { href: "/pwa/inventory", label: "Items" } : undefined,
      actions: "[[actions]]",
      get children() {
        return createComponent(LocaleEcho, {});
      },
    }),
);

const server = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    c.set("runtime" as never, { apps } satisfies RuntimeContext as never);
    c.set("settings" as never, { app: { name: "Example Cloud" } } as never);
    await next();
  })
  .get("/pwa/inventory", auth.requireRole("user", ssr.pwaAccess), auth.requireUser(ssr.pwaAccess), ...page)
  .get("/pwa/inventory/:id", auth.requireRole("user", ssr.pwaAccess), auth.requireUser(ssr.pwaAccess), ...page)
  .get("/pwa/admin-only", auth.requireRole("admin", ssr.pwaAccess), (c) => c.text("admin handler"))
  .get("/pwa/open", auth.requireRole("*"), ...page)
  .get("/pwa/missing", auth.requireRole("*"), (c) => ssr.error(c, 404, { layout: "pwa" }));

/** Only for parsing the HTML: the SSR render itself runs without browser globals. */
const parser = (() => {
  const dom = createDomTestHarness();
  dom.cleanup();
  return new dom.window.DOMParser();
})();

const render = async (path: string, headers: Record<string, string> = {}) => {
  const response = await server.request(path, { headers: { Cookie: "pwa_session=test-session", ...headers } });
  const html = await response.text();
  const document = parser.parseFromString(html, "text/html") as unknown as Document;
  return { response, html, document };
};

const tabs = (document: Document) =>
  [...document.querySelectorAll<HTMLAnchorElement>(".k2b-tab-bar a")].map((link) => ({
    href: link.getAttribute("href"),
    label: link.textContent,
    title: link.dataset.k2bTitle,
    current: link.getAttribute("aria-current") === "page",
  }));

describe("ssr.pwaAccess", () => {
  test("sends a page without an app session through Core's launch bounce and back to the same place", async () => {
    const response = await server.request("/pwa/inventory/42?view=open&sort=name");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `/pwa/_auth/session/launch?to=${encodeURIComponent("/pwa/inventory/42?view=open&sort=name")}`,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("never accepts a web session below /pwa/", async () => {
    signIn("web");
    const response = await server.request("/pwa/inventory", { headers: { Cookie: "session_token=test-session" } });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toStartWith("/pwa/_auth/session/launch?to=");
  });

  test("stops at the unavailable state after a bounce that did not bring a session", async () => {
    const response = await server.request("/pwa/inventory?pwa_launch=1");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/pwa/?pwa=unavailable");
  });

  test("answers a signed-in person without the role with the app's 403 page", async () => {
    signIn("app");
    const { response, document } = await render("/pwa/admin-only");
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(document.querySelector(".k2b-mobile-shell .k2b-placeholder")?.textContent).toContain("Access denied");
    expect(document.querySelector('.k2b-placeholder a[href="/pwa/"]')?.textContent).toBe("Back to Start");
    expect(document.querySelector('link[rel="manifest"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("admin handler");
    expect([response.headers.get("referrer-policy"), response.headers.get("content-security-policy")]).toEqual([
      "no-referrer",
      "frame-ancestors 'none'",
    ]);
  });

  test("renders the app's 404 in the phone frame", async () => {
    const { response, document } = await render("/pwa/missing", { "Accept-Language": "de" });
    expect(response.status).toBe(404);
    expect(document.querySelector(".k2b-mobile-shell__title")?.textContent).toBe("Seite nicht gefunden");
    expect(document.querySelector(".k2b-placeholder a")?.textContent).toBe("Zurück zum Start");
  });
});

describe("PwaLayout", () => {
  test("titles the page and the document, and passes back and actions to the header", async () => {
    signIn("app");
    apps = [shell, part("inventory", "Inventory")];
    const { document } = await render("/pwa/inventory?title=Shelf&back=1");
    expect(document.title).toBe("Shelf");
    expect(document.querySelector("h1.k2b-mobile-shell__title")?.textContent).toBe("Shelf");
    expect(document.querySelector('.k2b-mobile-shell__header a.k2b-mobile-shell__back[href="/pwa/inventory"]')).not.toBeNull();
    expect(document.querySelector(".k2b-mobile-shell__actions")?.textContent).toBe("[[actions]]");
    expect(document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute("content")).toBe("Example Cloud");
  });

  test("offers Start and the first three parts as tabs and marks the open part", async () => {
    signIn("app");
    apps = [shell, part("zeta", "Zeta"), part("inventory", "Inventory"), part("alpha", "Alpha"), part("beta", "Beta")];
    const { document } = await render("/pwa/inventory/42");
    expect(tabs(document)).toEqual([
      // While a tab's page loads, the header shows that page's title: Start's is the installation, a part's its name.
      { href: "/pwa/", label: "Start", title: "Example Cloud", current: false },
      { href: "/pwa/alpha", label: "Alpha", title: "Alpha", current: false },
      { href: "/pwa/beta", label: "Beta", title: "Beta", current: false },
      { href: "/pwa/inventory", label: "Inventory", title: "Inventory", current: true },
    ]);
    expect(document.querySelector(".k2b-tab-bar")?.getAttribute("aria-label")).toBe("App");
  });

  test("marks Start, which lists every part, for a part without its own tab", async () => {
    signIn("app");
    apps = [shell, part("alpha", "Alpha"), part("beta", "Beta"), part("gamma", "Gamma"), part("inventory", "Inventory")];
    const { document } = await render("/pwa/inventory");
    expect(tabs(document).filter((tab) => tab.current)).toEqual([{ href: "/pwa/", label: "Start", title: "Example Cloud", current: true }]);
  });

  test("hides the tab bar without parts and without a user, and keeps the session alive only for a user", async () => {
    signIn("app");
    apps = [shell];
    let { document, html } = await render("/pwa/open");
    expect(document.querySelector(".k2b-tab-bar")).toBeNull();
    expect(html).toContain("keepalive:!0");
    expect(html).toContain("reload:!0");

    tokenSpy.mockReturnValue(null);
    apps = [shell, part("inventory", "Inventory")];
    ({ document, html } = await render("/pwa/open"));
    expect(document.querySelector(".k2b-tab-bar")).toBeNull();
    expect(html).toContain("keepalive:!1");
    // A page without a person shows no times and may hold a pairing link in memory only: no timezone reload.
    expect(html).toContain("reload:!1");
  });

  test("refuses framing and referrers on every app page", async () => {
    signIn("app");
    apps = [shell];
    for (const path of ["/pwa/open", "/pwa/missing"]) {
      const { response } = await render(path);
      expect([path, response.headers.get("referrer-policy"), response.headers.get("content-security-policy")]).toEqual([
        path,
        "no-referrer",
        "frame-ancestors 'none'",
      ]);
    }
  });

  test("hides parts the person may not see", async () => {
    signIn("app");
    apps = [shell, part("inventory", "Inventory"), part("ops", "Operations", { pwa: { href: "/pwa/ops", requiresRoles: ["admin"] } })];
    const { document } = await render("/pwa/inventory");
    expect(tabs(document).map((tab) => tab.label)).toEqual(["Start", "Inventory"]);
  });

  test("renders in the request locale and theme", async () => {
    signIn("app");
    apps = [shell, part("inventory", "Inventory", { presentation: { baseLocale: "en", translations: { de: { name: "Lager" } } } })];
    const { document } = await render("/pwa/inventory", { Cookie: "pwa_session=test-session; theme=dark; cloud.locale=de" });
    expect(document.documentElement.getAttribute("lang")).toBe("de");
    expect(document.documentElement.className).toBe("dark");
    expect(document.querySelector("main")?.textContent).toContain("[[locale:de]]");
    expect(tabs(document).map((tab) => tab.label)).toEqual(["Start", "Lager"]);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#090d12");
  });

  test("catalog is complete", () => expect(pwaMessages.check()).toEqual([]));
});
