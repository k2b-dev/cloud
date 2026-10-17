import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { createComponent } from "solid-js";

const root = mkdtempSync(resolve(tmpdir(), "cloud-layout-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { defineApp } = await import("../_internal/define-app");
const { person } = await import("../_internal/define-app.test-fixture");
const railSnapshot = await import("../services/rail-snapshot");
const settingsMiddleware = await import("../server/middleware/settings");
const help = await import("./help");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const { default: Layout } = await import("./Layout");
const { default: MinimalLayout } = await import("./MinimalLayout");
const { useLocale } = await import("@k2b/ui");
const { default: AdminLayout } = await import("./AdminLayout");

const app = defineApp({
  id: "layout-render-probe",
  name: "Layout render probe",
  icon: "ti ti-layout",
  description: "Anonymous and minimal layout render probe",
  baseUrl: "http://layout-render-probe:3000",
  routes: ["/layout", "/minimal"],
});

type LayoutContextArg = Parameters<typeof Layout>[0]["c"];
/** The markup a browser keeps when the islands mount and render again. */
const withoutIslands = (html: string) => html.replace(/<solid-island\b[\s\S]*?<\/solid-island>/g, "");
type MinimalLayoutContextArg = Parameters<typeof MinimalLayout>[0]["c"];
const legalApp = {
  id: "legal-probe",
  legalLinks: [{ label: "Imprint", href: "/legal/imprint" }],
  presentation: { baseLocale: "en", translations: { de: { legalLinks: { "/legal/imprint": "Impressum" } } } },
};

const badgeApps = [
  {
    id: "chat-probe",
    name: "Chat probe",
    icon: "ti ti-message",
    description: "Counts unread messages",
    routes: ["/app/chat-probe", "/api/chat-probe"],
    nav: { href: "/app/chat-probe", section: "primary", badge: "/api/chat-probe/badge" },
  },
  {
    id: "mail-probe",
    name: "Mail probe",
    icon: "ti ti-mail",
    description: "Declares no badge",
    routes: ["/app/mail-probe"],
    nav: { href: "/app/mail-probe", section: "primary" },
  },
];

const server = new Hono()
  .use("*", async (c, next) => {
    c.set("runtime" as never, { apps: [] } as never);
    await next();
  })
  .get(
    "/admin",
    ...app.ssr(
      (c) => () =>
        createComponent(AdminLayout, {
          c,
          title: "Settings",
          scroll: c.req.query("scroll") !== "false",
          get children() {
            return `Admin content locale=${createComponent(() => useLocale()(), {})}`;
          },
        }),
    ),
  )
  // Admin pages of Core (prefix `/admin`) and of an app (its own `/admin/...` prefix), signed in.
  .get(
    "/admin/*",
    async (c, next) => {
      const core = { id: "core-probe", name: "Core", icon: "ti ti-settings", description: "Core", routes: ["/admin"] };
      c.set("runtime" as never, { apps: [core, { ...badgeApps[1], routes: ["/app/mail-probe", "/admin/mail-probe"] }] } as never);
      c.set("user" as never, person as never);
      await next();
    },
    ...app.ssr(
      (c) => () =>
        createComponent(AdminLayout, {
          c,
          title: c.req.query("title") ?? "Settings",
          children: "Admin content",
        }),
    ),
  )
  .get(
    "/layout",
    ...app.ssr((c) => {
      const mode = c.req.query("mode") ?? "fullPage";
      return () =>
        createComponent(Layout, {
          c: c as unknown as LayoutContextArg,
          fullPage: mode === "fullPage",
          fullWidth: mode === "fullWidth",
          title: "Public tools",
          help: c.req.queries("help"),
          children: "Anonymous content",
        });
    }),
  )
  .get(
    "/signed-in",
    async (c, next) => {
      c.set("runtime" as never, { apps: badgeApps } as never);
      c.set("user" as never, person as never);
      await next();
    },
    ...app.ssr(
      (c) => () =>
        createComponent(Layout, {
          c: c as unknown as LayoutContextArg,
          title: [{ title: "Badges", href: "/app/badges" }, { title: c.req.query("title") ?? "Badges" }],
          focusMode: c.req.query("focusMode") === "true",
          printHint: c.req.query("printHint"),
          children: "Signed-in content",
        }),
    ),
  )
  .get(
    "/minimal/:mode",
    async (c, next) => {
      c.set("runtime" as never, { apps: [legalApp] } as never);
      await next();
    },
    ...app.ssr((c) => {
      const mode = c.req.param("mode");
      // "bottom-left" is a deprecated corner position that now means "show the footer".
      const preferences = mode === "off" ? false : mode === "bottom-left" ? "bottom-left" : undefined;
      return () =>
        createComponent(MinimalLayout, {
          c: c as unknown as MinimalLayoutContextArg,
          preferences,
          children: "Minimal content",
        });
    }),
  );

describe("Cloud layouts SSR", () => {
  test("server-renders shell focus only on signed-in pages outside focusMode", async () => {
    const spies = [
      spyOn(railSnapshot, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
      spyOn(settingsMiddleware, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    ];
    try {
      for (const [path, cookie, hidden, controls] of [
        ["/signed-in", "cloud_shell_focus=1", true, true],
        ["/signed-in", "", false, true],
        ["/layout", "cloud_shell_focus=1", false, false],
        ["/signed-in?focusMode=true", "cloud_shell_focus=1", false, false],
      ] as const) {
        const response = await server.request(path, { headers: { Cookie: cookie } });
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html.includes('data-shell-focus="true"'), path + " focus").toBe(hidden);
        expect(html.includes('data-cloud-shell-focus-toggle="hide"'), path + " hide").toBe(controls);
        expect(html.includes('data-cloud-shell-focus-toggle="show"'), path + " show").toBe(controls);
        expect(html.includes('class="cloud-shell-show"')).toBe(controls);
        expect(html.includes("data-cloud-shell-reveal")).toBe(controls);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
  test("full-page workspaces contain outer viewport overscroll", async () => {
    const html = await (await server.request("/layout")).text();
    expect(html).toContain('data-layout-full-page="true"');
    const css = await Bun.file(new URL("../styles/global.css", import.meta.url)).text();
    expect(css).toContain('html:has(.cloud-app-canvas[data-layout-full-page="true"])');
    expect(css).toContain("overscroll-behavior: none;");
  });
  test("the shell reserves a stable scrollbar gutter on the page scroller it owns", async () => {
    const render = async (mode: string) => {
      const html = await (await server.request(`/layout?mode=${mode}`)).text();
      return {
        main: html.match(/<main[^>]*class="([^"]*layout-content-main[^"]*)"/)?.[1],
        canvas: html.match(/<div[^>]*class="cloud-app-canvas[^>]*>/)?.[0],
      };
    };
    const [page, fullWidth, fullPage] = await Promise.all([render("page"), render("fullWidth"), render("fullPage")]);
    // From md, `main` scrolls regular pages; fullWidth and fullPage work surfaces own their scrolling.
    expect(page.main).toContain("md:overflow-auto md:[scrollbar-gutter:stable]");
    for (const { main } of [fullWidth, fullPage]) {
      expect(main).toContain("flex flex-col");
      expect(main).not.toContain("scrollbar-gutter");
    }
    // Below md only anonymous regular pages use the document scroller.
    expect(page.canvas).not.toContain("data-layout-full-page");
    expect(fullWidth.canvas).not.toContain("data-layout-full-page");
    expect(fullPage.canvas).toContain('data-layout-full-page="true"');
    const css = await Bun.file(new URL("../styles/global.css", import.meta.url)).text();
    const mobileStart = css.indexOf("@media not all and (min-width: 768px) {");
    const mobileShell = css.slice(mobileStart, css.indexOf("\n}", mobileStart));
    expect(mobileShell).toMatch(
      /html:has\(\.cloud-app-canvas:not\(\[data-layout-full-page\], \[data-layout-authenticated\]\)\) \{ scrollbar-gutter: stable; \}/,
    );
  });
  test("admin children inherit the request locale during SSR", async () => {
    for (const locale of ["de", "en", "de-CH"]) {
      const response = await server.request("/admin", { headers: { "Accept-Language": locale } });
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain(`<html lang="${locale}"`);
      expect(html).toContain(`Admin content locale=${locale}`);
    }
  });
  test("admin shell is viewport-bound and delegates scrolling only when requested", async () => {
    const ordinary = await (await server.request("/admin")).text();
    const bounded = await (await server.request("/admin?scroll=false")).text();
    for (const html of [ordinary, bounded]) {
      expect(html).toContain("h-dvh overflow-hidden");
      expect(html).toContain("Admin content");
      expect(html).toContain('data-scroll-preserve="admin-sidebar"');
    }
    expect(ordinary).not.toMatch(/k2b-app-workspace__main[^>]+data-scroll="false"/);
    expect(bounded).toMatch(/k2b-app-workspace__main[^>]+data-scroll="false"/);
    expect(bounded).not.toContain("p-[var(--ui-space-shell)]");
  });
  test("every admin page is one level below Admin, whether Core or an app owns it", async () => {
    const spies = [
      spyOn(railSnapshot, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
      spyOn(settingsMiddleware, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
      spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
    ];
    try {
      const trailOf = async (path: string) => {
        const html = await (await server.request(path, { headers: { "Accept-Language": "en" } })).text();
        return JSON.parse(html.match(/<script type="application\/json" data-k2b-page-trail>([^<]*)<\/script>/)?.[1] ?? "null");
      };
      expect(await trailOf("/admin/settings")).toEqual({ title: "Settings", ancestors: [] });
      expect(await trailOf("/admin/mail-probe/security?title=Mail%20security")).toEqual({ title: "Mail security", ancestors: [] });
      expect(await trailOf("/admin/overview?title=Overview")).toEqual({ title: "Admin", ancestors: [] });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test("keeps anonymous login and preferences visible without rendering the application rail", async () => {
    const response = await server.request("/layout", {
      headers: { Cookie: "theme=dark", "Accept-Language": "de-CH" },
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<html lang="de-CH" class="dark"');
    expect(html).toContain("layout-header");
    expect(html).toContain('href="/auth/login"');
    expect(html).toContain("Anmelden");
    expect(html).toContain("Darstellung und Sprache");
    expect(html).toContain('aria-label="Darstellung: Dunkel. Wechselt zu Automatisch."');
    expect(html).toContain("English");
    expect(html).not.toContain("layout-rail-navigation");
    expect(html).not.toContain('data-layout-authenticated="true"');
    expect(html).not.toContain('href="/me"');
  });

  test("anonymous pages keep their header, with the app name and controls up to lg and breadcrumbs from lg", async () => {
    const html = await (await server.request("/layout")).text();
    const header = html.match(/<header[^>]*class="(layout-header[^"]*)"/)?.[1];
    expect(header).toBeDefined();
    expect(header).not.toContain("md:hidden");
    expect(html).toContain('<div class="hidden min-w-0 items-center lg:flex">');
    expect(html).toContain('<div class="flex items-center gap-1 lg:hidden">');
    // Home and Sign in stay server markup, so focus on them survives the shell's mount.
    const chrome = withoutIslands(html).match(/<header[\s\S]*?<\/header>/)?.[0] ?? "";
    expect(chrome).toContain('href="/"');
    expect(chrome).toContain('href="/auth/login"');
    expect(html).not.toContain('class="cloud-tab-bar"');
  });

  test("signed-in pages trade the header for the rail from md and publish the page trail", async () => {
    const spies = [
      spyOn(railSnapshot, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
      spyOn(settingsMiddleware, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    ];
    let html: string;
    try {
      const title = encodeURIComponent('Q4 "Plan" \\ <notes>');
      html = await (await server.request(`/signed-in?title=${title}`, { headers: { "Accept-Language": "en" } })).text();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    // The header remains for phones only, and it never carries breadcrumbs or an avatar.
    expect(html.match(/<header[^>]*class="(layout-header[^"]*)"/)?.[1]).toContain("md:hidden");
    expect(html).not.toContain("hidden min-w-0 items-center lg:flex");
    expect(html.split('class="layout-profile-preferences"').length - 1).toBe(1);
    expect(html).toContain('class="layout-rail hidden w-14 shrink-0 flex-col md:flex"');
    // Home stays in the rail; phones get Home and the person's apps in the bar, as server markup outside the shell's
    // islands, so focus on it survives their mount.
    const chrome = withoutIslands(html);
    expect(chrome).toMatch(/<aside class="layout-rail[^"]*"><div class="layout-rail-logo[^"]*"><a href="\/" aria-label="Home">/);
    expect(chrome.match(/<header[\s\S]*?<\/header>/)?.[0]).not.toContain('href="/"');
    const bar = chrome.slice(chrome.indexOf('class="cloud-tab-bar"'));
    expect(bar).toContain('href="/"');
    expect(bar).toContain('data-tab="home"');
    const start = bar.match(/<a href="\/"[^>]*>([\s\S]*?)<\/a>/)?.[1];
    expect(start).toContain("<span>Home</span>");
    for (const app of badgeApps) expect(bar).toContain(`href="${app.nav.href}"`);
    // The page trail travels as JSON that cannot end its script element or carry markup.
    const source = html.match(/<script type="application\/json" data-k2b-page-trail>([^<]*)<\/script>/)?.[1] ?? "";
    expect(source).toContain("\\u003cnotes>");
    expect(JSON.parse(source).title).toBe('Q4 "Plan" \\ <notes>');
  });

  test("hands the rail and the app grid each app's badge route but renders no count on the server", async () => {
    // The signed-in shell preloads the person's rail and announcements; neither matters for badges.
    const spies = [
      spyOn(railSnapshot, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
      spyOn(settingsMiddleware, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    ];
    let status: number;
    let html: string;
    try {
      const response = await server.request("/signed-in", { headers: { "Accept-Language": "en" } });
      status = response.status;
      html = await response.text();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(status).toBe(200);
    const embedded = (id: string) => JSON.parse(html.match(new RegExp(`<script id="${id}" type="application/json">(.*?)</script>`))![1]!);
    const badges = (apps: { id: string; badge?: string }[]) => Object.fromEntries(apps.map((entry) => [entry.id, entry.badge ?? null]));
    const expected = { "chat-probe": "/api/chat-probe/badge", "mail-probe": null };
    expect(badges(embedded("cloud-shell-data").apps)).toEqual(expected);
    expect(html.match(/id="cloud-shell-data"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Chat probe"');
    expect(html).not.toContain("cloud-app-badge");
  });

  test("ends minimal pages with legal links and labeled language and theme settings", async () => {
    for (const mode of ["default", "bottom-left"]) {
      const response = await server.request(`/minimal/${mode}`, { headers: { "Accept-Language": "en-US" } });
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toMatch(/<div class="minimal-layout">Minimal content.*<footer class="minimal-layout-footer">/s);
      expect(html).toContain('<nav class="minimal-layout-footer__links" aria-label="Legal">');
      expect(html).toContain('href="/legal/imprint" target="_blank" rel="noopener"');
      expect(html).toContain(">Imprint</a>");
      expect(html).toContain('aria-label="Language: English"');
      expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(1);
      expect(html).toContain('aria-label="Appearance: Automatic. Switches to Light."');
      expect(html).not.toContain("Appearance and language");
      expect(html).not.toContain("cloud-app-canvas");
      expect(html).not.toContain("layout-header");
      expect(html).not.toContain("layout-rail");
    }
  });

  test("renders the footer in the visitor's language and theme", async () => {
    const response = await server.request("/minimal/default", {
      headers: { "Accept-Language": "de-DE,de;q=0.9,en;q=0.8", Cookie: "theme=dark" },
    });
    const html = await response.text();
    expect(html).toContain('<html lang="de-DE" class="dark"');
    expect(html).toContain('aria-label="Rechtliches"');
    expect(html).toContain(">Impressum</a>");
    expect(html).toContain('aria-label="Sprache: Deutsch"');
    expect(html).toContain('aria-label="Darstellung: Dunkel. Wechselt zu Automatisch."');
  });

  test("an explicit language choice outranks the browser language on anonymous pages", async () => {
    const html = await (
      await server.request("/minimal/default", { headers: { "Accept-Language": "de-DE,de;q=0.9", Cookie: "cloud.locale=en" } })
    ).text();
    expect(html).toContain('<html lang="en"');
    expect(html).toContain('aria-label="Language: English"');
  });

  test("can leave out the footer completely", async () => {
    const response = await server.request("/minimal/off");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Minimal content");
    expect(html).not.toContain("minimal-layout");
    expect(html).not.toContain("<footer");
  });
});

for (const focusMode of [false, true]) {
  test(`renders the app print hint last in the canvas (focus=${focusMode})`, async () => {
    const spy = spyOn(railSnapshot, "readRailSnapshot").mockResolvedValue(defaultRailPreferences());
    const announcements = spyOn(settingsMiddleware, "preloadLayoutAnnouncements").mockResolvedValue(undefined);
    try {
      const html = await (await server.request(`/signed-in?focusMode=${focusMode}&printHint=Download%20the%20PDF`)).text();
      expect(html).toMatch(/data-print-fallback(?:="")?>/);
      expect(html).toContain("This view does not print well.");
      expect(html).toContain("Download the PDF");
      expect(html).toMatch(/Download the PDF<\/p><\/div><\/div>/);
    } finally {
      spy.mockRestore();
      announcements.mockRestore();
    }
  });
}

describe("Layout page Help payload", () => {
  for (const failed of [false, true]) {
    test(`shell data ${failed ? "reports a Help metadata failure" : "omits helpFailed without a Help metadata failure"}`, async () => {
      const spies = [spyOn(help, "getLayoutHelp").mockReturnValue(null), spyOn(help, "layoutHelpFailed").mockReturnValue(failed)];
      try {
        const html = await (await server.request("/layout")).text();
        const data = JSON.parse(html.match(/<script id="cloud-shell-data" type="application\/json">([^<]*)<\/script>/)?.[1] ?? "null");
        expect(data).not.toBeNull();
        if (failed) expect(data.helpFailed).toBe(true);
        else expect(data).not.toHaveProperty("helpFailed");
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  }

  const documents = ["first", "second", "third", "fourth"].map((id) => ({
    id,
    title: id,
    order: 100,
    searchUrl: "/search",
    url: `/documents/${id}`,
  }));
  for (const [name, manifest, requested, expected] of [
    [
      "keeps declared order, deduplicates and caps at three",
      true,
      ["unknown", "third", "third", "first", "fourth", "second"],
      ["third", "first", "fourth"],
    ],
    ["drops ids outside the reader's manifest", true, ["private", "other-app", "second"], ["second"]],
    ["omits Help when every id is unknown", true, ["private"], undefined],
    ["omits Help without an authorized manifest", false, ["first"], undefined],
    ["omits Help without page ids", true, [], undefined],
  ] as const) {
    test(name, async () => {
      const spy = spyOn(help, "getLayoutHelp").mockReturnValue(
        manifest
          ? {
              documents,
              pageBase: "/help/apps/probe",
              baseLocale: "en",
              locale: "en",
              manifestHash: "test",
            }
          : null,
      );
      try {
        const query = new URLSearchParams();
        for (const id of requested) query.append("help", id);
        const html = await (await server.request(`/layout?${query}`)).text();
        const data = JSON.parse(html.match(/<script id="cloud-shell-data" type="application\/json">([^<]*)<\/script>/)?.[1] ?? "null");
        expect(data).not.toBeNull();
        if (expected) expect(data.help).toEqual([...expected]);
        else expect(data).not.toHaveProperty("help");
      } finally {
        spy.mockRestore();
      }
    });
  }

  for (const [userAgent, platform] of [
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", "apple"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "other"],
    ["", "other"],
  ]) {
    test(`resolves keyboard platform ${platform} from ${userAgent || "an absent User-Agent"}`, async () => {
      const html = await (await server.request("/layout", { headers: { "User-Agent": userAgent! } })).text();
      const data = JSON.parse(html.match(/<script id="cloud-shell-data" type="application\/json">([^<]*)<\/script>/)?.[1] ?? "null");
      expect(data?.platform).toBe(platform);
    });
  }
});
