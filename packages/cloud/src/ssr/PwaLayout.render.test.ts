import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { fromJSON } from "seroval";
import { createComponent } from "solid-js";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { createDomTestHarness } from "../../../ui/test/dom";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import * as watcher from "../_internal/runtime-watcher";
import type { RuntimeAppMeta } from "../contracts/app";
import * as builds from "../contracts/pwa-builds";
import type { User } from "../contracts/shared";
import { type AuthContext, auth } from "../server/middleware/auth";
import { announcements } from "../services/announcements";
import { session } from "../services/session";
import { pwaMessages } from "./pwa-messages";
import type { RuntimeContext } from "./runtime";

const root = mkdtempSync(join(tmpdir(), "cloud-pwa-layout-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

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
      back: c.req.query("back") ? { href: "/pwa/inventory", label: "Items", withSidebar: c.req.query("back") !== "phone" } : undefined,
      sidebarTitle: c.req.query("sidebarTitle"),
      actions: "[[actions]]",
      ui: c.req.query("ui") === "v2" ? "v2" : undefined,
      bare: c.req.query("bare") !== undefined,
      screen: c.req.query("screen") !== undefined,
      get children() {
        return createComponent(LocaleEcho, {});
      },
    }),
);

const server = new Hono<AuthContext>()
  .onError((_, c) => c.text("Render failed", 500))
  .use("*", async (c, next) => {
    c.set("runtime" as never, { apps } satisfies RuntimeContext as never);
    c.set("settings" as never, { app: { name: "Example Cloud" } } as never);
    await next();
  })
  .get("/pwa/", auth.requireRole("*"), ...page)
  .get("/pwa/settings", auth.requireRole("*"), ...page)
  .get("/pwa/inventory", auth.requireRole("user", ssr.pwaAccess), auth.requireUser(ssr.pwaAccess), ...page)
  .get("/pwa/inventory/:id", auth.requireRole("user", ssr.pwaAccess), auth.requireUser(ssr.pwaAccess), ...page)
  .get("/pwa/admin-only", auth.requireRole("admin", ssr.pwaAccess), (c) => c.text("admin handler"))
  .get("/pwa/open", auth.requireRole("*"), ...page)
  .get(
    "/pwa/render-fails",
    auth.requireRole("user", ssr.pwaAccess),
    ...ssr<AuthContext>(() => () => {
      throw new Error("Render failure fixture");
    }),
  )
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

const islandProps = (document: Document, file: string): unknown =>
  fromJSON(JSON.parse(document.querySelector(`solid-island[data-file="${file}"]`)?.getAttribute("data-props") ?? ""));

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

  test("a part that refuses names itself, in the reader's language", async () => {
    signIn("app");
    apps = [shell, part("inventory", "Inventory", { presentation: { baseLocale: "en", translations: { de: { name: "Lager" } } } })];
    try {
      const english = await render("/pwa/admin-only");
      expect(english.response.status).toBe(403);
      expect(english.document.querySelector(".k2b-placeholder")?.textContent).toContain("Inventory is not available to you");
      expect(english.document.title).toContain("Inventory is not available to you");
      const german = await render("/pwa/admin-only", { "Accept-Language": "de" });
      expect(german.document.querySelector(".k2b-placeholder")?.textContent).toContain("Lager ist für dich nicht freigegeben");
      expect(german.document.querySelector('.k2b-placeholder a[href="/pwa/"]')?.textContent).toBe("Zum Start");
      // A part with declared access is left out of the display view until it is preloaded; its own page still names it.
      apps = [shell, part("inventory", "Inventory", { access: { kind: "signedIn" } })];
      const declared = await render("/pwa/admin-only");
      expect(declared.document.querySelector(".k2b-placeholder")?.textContent).toContain("Inventory is not available to you");
    } finally {
      apps = [];
    }
  });

  test("renders the app's 404 in the phone frame", async () => {
    const { response, document } = await render("/pwa/missing", { "Accept-Language": "de" });
    expect(response.status).toBe(404);
    expect(document.querySelector(".k2b-mobile-shell__title")?.textContent).toBe("Seite nicht gefunden");
    expect(document.querySelector(".k2b-placeholder a")?.textContent).toBe("Zum Start");
  });
});

describe("PwaLayout", () => {
  test("compares the renderer's actual build and Core shared assets, including on error pages", async () => {
    signIn("app");
    apps = [shell, part("inventory", "Inventory")];
    const own = spyOn(builds, "pwaBuild").mockReturnValue("rendered-build");
    const registered = spyOn(watcher, "registeredPwaBuilds").mockReturnValue({
      inventory: "registry-can-already-be-newer",
      core: "core-rendered",
    });
    try {
      for (const path of ["/pwa/inventory", "/pwa/missing"]) {
        const { document } = await render(path);
        expect(islandProps(document, "PwaRuntime.island.tsx")).toMatchObject({
          builds: { inventory: "rendered-build", core: "core-rendered" },
        });
      }
    } finally {
      own.mockRestore();
      registered.mockRestore();
    }
  });
  test("remembers only successful signed-in pages, including the query and excluding bounce markers", async () => {
    signIn("app");
    apps = [shell, part("inventory", "Inventory")];
    const { response } = await render("/pwa/inventory/42?view=mine&pwa_launch=1");
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith("pwa_last_address="))!;
    expect(cookie).toContain("pwa_last_address=%2Fpwa%2Finventory%2F42%3Fview%3Dmine;");
    for (const attribute of ["Path=/pwa/", "Secure", "SameSite=Lax"]) expect(cookie).toContain(attribute);
    expect(islandProps((await render("/pwa/missing")).document, "PwaRuntime.island.tsx")).toMatchObject({ rememberAddress: undefined });
    expect((await render("/pwa/missing")).response.headers.getSetCookie().some((value) => value.startsWith("pwa_last_address="))).toBe(
      false,
    );
    const failed = await server.request("/pwa/render-fails", { headers: { Cookie: "pwa_session=test-session" } });
    expect(failed.status).toBe(500);
    expect(failed.headers.getSetCookie().some((value) => value.startsWith("pwa_last_address="))).toBe(false);
    tokenSpy.mockReturnValue(null);
    sessionSpy.mockResolvedValue(null);
    expect((await render("/pwa/open")).response.headers.getSetCookie().some((value) => value.startsWith("pwa_last_address="))).toBe(false);
  });
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
    expect(document.querySelectorAll(".k2b-tab-bar a > span.k2b-truncate-fade").length).toBe(4);
  });

  test("a part's badge calls for attention in the sidebar and on its tab; a summary's count stays quiet in the sidebar", async () => {
    signIn("app");
    apps = [
      shell,
      part("alpha", "Alpha", { pwa: { href: "/pwa/alpha", badge: "/pwa/alpha/unread", summary: "/pwa/alpha/unread" } }),
      part("beta", "Beta", { pwa: { href: "/pwa/beta", summary: "/pwa/beta/summary" } }),
      part("inventory", "Inventory"),
    ];
    const { document } = await render("/pwa/inventory");
    const island = (scope: Element | null) => scope?.querySelector('solid-island[data-file="PwaPartCount.island.tsx"]');
    const props = (scope: Element | null) => island(scope)?.getAttribute("data-props") ?? "";
    const sidebar = (id: string) => document.querySelector(`.k2b-mobile-shell__sidebar a[data-tab="${id}"]`);
    const tab = (id: string) => document.querySelector(`.k2b-tab-bar a[data-tab="${id}"]`);
    expect(props(sidebar("alpha"))).toContain("/pwa/alpha/unread");
    expect(props(sidebar("alpha"))).toContain("attention");
    expect(props(tab("alpha")?.querySelector(".k2b-tab-bar__badge") ?? null)).toContain("attention");
    expect(props(sidebar("beta"))).toContain("/pwa/beta/summary");
    expect(props(sidebar("beta"))).not.toContain("attention");
    expect(tab("beta")?.querySelector(".k2b-tab-bar__badge")).toBeNull();
    expect(island(sidebar("inventory"))).toBeNull();
    expect(tab("inventory")?.querySelector(".k2b-tab-bar__badge")).toBeNull();
  });

  test("a part's pages take its app colour for selection and accents; parts without one keep Cloud's", async () => {
    signIn("app");
    apps = [shell, part("inventory", "Inventory", { appearance: { accent: "#8e1b6f" } })];
    const coloured = (await render("/pwa/inventory")).document.body;
    expect(coloured.classList.contains("app-accent-scope")).toBe(true);
    expect(coloured.getAttribute("style")).toContain("--app-accent:#8e1b6f");
    apps = [shell, part("inventory", "Inventory")];
    const plain = (await render("/pwa/inventory")).document.body;
    expect(plain.classList.contains("app-accent-scope")).toBe(false);
    expect(plain.getAttribute("style")).toBeNull();
  });

  test("a part's AI primary reaches its document; other parts and shell pages keep blue", async () => {
    signIn("app");
    apps = [shell, part("inventory", "Inventory", { appearance: { accent: "#0f766e", primary: "ai" } }), part("open", "Open")];
    expect((await render("/pwa/inventory")).document.body.getAttribute("data-k2b-primary")).toBe("ai");
    for (const [path, status] of [
      ["/pwa/", 200],
      ["/pwa/settings", 200],
      ["/pwa/open", 200],
      ["/pwa/missing", 404],
    ] as const) {
      const { response, document } = await render(path);
      expect(response.status).toBe(status);
      expect(document.body.hasAttribute("data-k2b-primary")).toBe(false);
    }
    apps = [shell, part("inventory", "Inventory", { appearance: { accent: "#0f766e" } })];
    expect((await render("/pwa/inventory")).document.body.hasAttribute("data-k2b-primary")).toBe(false);
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
    let { document } = await render("/pwa/open");
    expect(document.querySelector(".k2b-tab-bar")).toBeNull();
    expect(islandProps(document, "PwaRuntime.island.tsx")).toMatchObject({ keepalive: true });
    expect(islandProps(document, "TimezoneCookie.island.tsx")).toMatchObject({ reload: true });

    tokenSpy.mockReturnValue(null);
    apps = [shell, part("inventory", "Inventory")];
    ({ document } = await render("/pwa/open"));
    expect(document.querySelector(".k2b-tab-bar")).toBeNull();
    expect(islandProps(document, "PwaRuntime.island.tsx")).toMatchObject({ keepalive: false });
    // A page without a person shows no times and may hold a pairing link in memory only: no timezone reload.
    expect(islandProps(document, "TimezoneCookie.island.tsx")).toMatchObject({ reload: false });
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

// `ui="v2"`: the same page, its access and its redirects, in a v2 frame that loads Core's v2.css alone and no v1 shell.
describe("PwaLayout ui v2", () => {
  const v2Tabs = (document: Document) =>
    [...document.querySelectorAll<HTMLAnchorElement>(".pwa-v2-tabs a")].map((link) => ({
      href: link.getAttribute("href"),
      label: link.querySelector(".pwa-v2-tab-label")?.textContent,
      current: link.getAttribute("aria-current") === "page",
      badge: (islandProps(link.ownerDocument, "PwaNavigationV2.island.tsx") as { tabs: { href: string; badge?: string }[] }).tabs.find(
        (tab) => tab.href === link.getAttribute("href"),
      )?.badge,
    }));
  const v1Shell = /k2b-mobile-shell|k2b-tab-bar|k2b-button|k2b-placeholder|PwaRuntime\.island|PwaPartCount\.island/;

  test("keeps the access and the launch bounce of every app page", async () => {
    const response = await server.request("/pwa/inventory/42?ui=v2");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/pwa/_auth/session/launch?to=${encodeURIComponent("/pwa/inventory/42?ui=v2")}`);
    signIn("web");
    const web = await server.request("/pwa/inventory?ui=v2", { headers: { Cookie: "session_token=test-session" } });
    expect(web.headers.get("location")).toStartWith("/pwa/_auth/session/launch?to=");
  });

  test("is a v2 page with Core's v2.css alone, its head, and no v1 shell", async () => {
    signIn("app");
    apps = [shell, part("inventory", "Inventory")];
    const routes = spyOn(watcher, "registeredCoreRoutes").mockReturnValue(["/public/global.css", "/public/v2.css"]);
    try {
      const { response, html, document } = await render("/pwa/inventory?ui=v2&title=Shelf&back=1");
      expect(response.status).toBe(200);
      expect(document.title).toBe("Shelf");
      const sheets = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(
        (link) => link.getAttribute("href") ?? "",
      );
      expect(sheets.some((href) => href.startsWith("/public/v2.css"))).toBe(true);
      expect(sheets.some((href) => href.startsWith("/public/global.css"))).toBe(false);
      expect(document.body.classList.contains("k2-ui")).toBe(true);
      // The document is the v2 frame, not a MobileShell.
      expect(document.documentElement.hasAttribute("data-pwa-v2")).toBe(true);
      expect(html).not.toMatch(v1Shell);
      const frame = document.querySelector(".k2-ui.pwa-v2");
      expect(frame?.getAttribute("data-ui")).toBe("v2");
      // Without `bare` the frame holds the page in a Workspace with the head and one Pane.
      const head = frame?.querySelector('[data-k2-part="Workspace"] [data-slot="head"]');
      expect(head?.querySelector(".pwa-v2-title")?.textContent).toBe("Shelf");
      expect(head?.querySelector('.pwa-v2-back a[href="/pwa/inventory"]')?.getAttribute("aria-label")).toBe("Items");
      expect(head?.querySelector(".k2-bar-end")?.textContent).toBe("[[actions]]");
      expect(frame?.querySelector('main [data-k2-part="Pane"]')?.textContent).toContain("[[locale:en]]");
      expect([response.headers.get("referrer-policy"), response.headers.get("content-security-policy")]).toEqual([
        "no-referrer",
        "frame-ancestors 'none'",
      ]);
    } finally {
      routes.mockRestore();
    }
  });

  test("beside an older Core it keeps global.css, with the same frame", async () => {
    signIn("app");
    apps = [shell, part("inventory", "Inventory")];
    const routes = spyOn(watcher, "registeredCoreRoutes").mockReturnValue(["/public/global.css"]);
    try {
      const { document } = await render("/pwa/inventory?ui=v2");
      const sheets = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(
        (link) => link.getAttribute("href") ?? "",
      );
      expect(sheets.some((href) => href.startsWith("/public/global.css"))).toBe(true);
      expect(sheets.some((href) => href.startsWith("/public/v2.css"))).toBe(false);
      expect(document.querySelector(".k2-ui.pwa-v2")).not.toBeNull();
    } finally {
      routes.mockRestore();
    }
  });

  test("offers Start and the first three parts as tabs, a count only for a badge, and every part in the sidebar", async () => {
    signIn("app");
    apps = [
      shell,
      part("zeta", "Zeta"),
      part("inventory", "Inventory"),
      part("alpha", "Alpha", { pwa: { href: "/pwa/alpha", badge: "/pwa/alpha/unread" } }),
      part("beta", "Beta", { pwa: { href: "/pwa/beta", summary: "/pwa/beta/summary" } }),
    ];
    const { document } = await render("/pwa/inventory/42?ui=v2");
    expect(document.querySelector(".pwa-v2")?.hasAttribute("data-tabs")).toBe(true);
    expect(document.querySelector(".pwa-v2-tabs")?.getAttribute("aria-label")).toBe("App");
    expect(v2Tabs(document)).toEqual([
      { href: "/pwa/", label: "Start", current: false, badge: undefined },
      { href: "/pwa/alpha", label: "Alpha", current: false, badge: "/pwa/alpha/unread" },
      { href: "/pwa/beta", label: "Beta", current: false, badge: undefined },
      { href: "/pwa/inventory", label: "Inventory", current: true, badge: undefined },
    ]);
    expect(document.querySelector('.pwa-v2-tabs a[href="/pwa/"]')?.getAttribute("title")).toBe("Example Cloud");
    const navigation = islandProps(document, "PwaNavigationV2.island.tsx") as Record<string, unknown>;
    expect({ ...navigation, tabs: undefined } as Record<string, unknown>).toEqual({
      title: "Example Cloud",
      start: { id: "start", label: "Start", icon: "home", href: "/pwa/", current: false },
      appsLabel: "Apps",
      parts: [
        { id: "alpha", label: "Alpha", icon: "alpha", href: "/pwa/alpha", current: false, badge: "/pwa/alpha/unread" },
        { id: "beta", label: "Beta", icon: "beta", href: "/pwa/beta", current: false, summary: "/pwa/beta/summary" },
        { id: "inventory", label: "Inventory", icon: "inventory", href: "/pwa/inventory", current: true },
        { id: "zeta", label: "Zeta", icon: "zeta", href: "/pwa/zeta", current: false },
      ],
      settings: { id: "settings", label: "Settings", icon: "settings", href: "/pwa/settings", current: false },
      tabsLabel: "App",
      tabs: undefined,
      endpoints: ["/pwa/alpha/unread", "/pwa/beta/summary"],
    });
    // The sidebar's entries are links in the server's page, before the counts arrive.
    expect(document.querySelector('.pwa-v2-nav nav a[href="/pwa/inventory"]')?.getAttribute("aria-current")).toBe("page");
  });

  test("a bare page brings its own workspace; a screen page has no tab bar", async () => {
    signIn("app");
    apps = [shell, part("inventory", "Inventory")];
    const bare = (await render("/pwa/inventory?ui=v2&bare")).document;
    expect(bare.querySelector(".pwa-v2-main")?.textContent).toBe("[[locale:en]]");
    expect(bare.querySelector('[data-k2-part="Workspace"]')).toBeNull();
    const screen = (await render("/pwa/inventory?ui=v2&bare&screen")).document.querySelector(".pwa-v2");
    expect(screen?.hasAttribute("data-screen")).toBe(true);
    expect(screen?.hasAttribute("data-tabs")).toBe(false);
  });

  test("names the sidebar's page on wide screens and hides a back link the sidebar already leads to", async () => {
    signIn("app");
    apps = [shell, part("inventory", "Inventory")];
    const { document } = await render("/pwa/inventory/42?ui=v2&title=Shelf&sidebarTitle=Inventory&back=phone");
    expect(document.querySelector(".pwa-v2-title .pwa-v2-phone-only")?.textContent).toBe("Shelf");
    expect(document.querySelector(".pwa-v2-title .pwa-v2-wide-only")?.textContent).toBe("Inventory");
    expect(document.querySelector(".pwa-v2-back")?.getAttribute("data-with-sidebar")).toBe("hide");
  });

  test("without a person: no sidebar, no tabs, no keepalive and no timezone reload; builds reach the runtime", async () => {
    signIn("app");
    apps = [shell, part("inventory", "Inventory")];
    const own = spyOn(builds, "pwaBuild").mockReturnValue("rendered-build");
    const registered = spyOn(watcher, "registeredPwaBuilds").mockReturnValue({ core: "core-rendered" });
    try {
      const signedIn = (await render("/pwa/inventory?ui=v2")).document;
      expect(islandProps(signedIn, "PwaRuntimeV2.island.tsx")).toMatchObject({
        keepalive: true,
        accountId: user.id,
        cloud: "Example Cloud",
        builds: { inventory: "rendered-build", core: "core-rendered" },
        rememberAddress: { cookie: "pwa_last_address" },
      });
      tokenSpy.mockReturnValue(null);
      const open = (await render("/pwa/open?ui=v2")).document;
      expect(open.querySelector(".pwa-v2")?.hasAttribute("data-sidebar")).toBe(false);
      expect(open.querySelector(".pwa-v2-nav")).toBeNull();
      expect(open.querySelector(".pwa-v2-tabs")).toBeNull();
      expect(islandProps(open, "PwaRuntimeV2.island.tsx")).toMatchObject({ keepalive: false });
      expect(islandProps(open, "TimezoneCookie.island.tsx")).toMatchObject({ reload: false });
    } finally {
      own.mockRestore();
      registered.mockRestore();
    }
  });

  test("renders in the request locale", async () => {
    signIn("app");
    apps = [shell, part("inventory", "Inventory", { presentation: { baseLocale: "en", translations: { de: { name: "Lager" } } } })];
    const { document } = await render("/pwa/inventory?ui=v2", { Cookie: "pwa_session=test-session; cloud.locale=de" });
    expect(document.documentElement.getAttribute("lang")).toBe("de");
    expect(document.querySelector("main")?.textContent).toContain("[[locale:de]]");
    expect(v2Tabs(document).map((tab) => tab.label)).toEqual(["Start", "Lager"]);
    expect((islandProps(document, "PwaNavigationV2.island.tsx") as { settings: { label: string } }).settings.label).toBe("Einstellungen");
  });
});
