import { describe, expect, test } from "bun:test";
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
type MinimalLayoutContextArg = Parameters<typeof MinimalLayout>[0]["c"];
const legalApp = {
  id: "legal-probe",
  legalLinks: [{ label: "Imprint", href: "/legal/imprint" }],
  presentation: { baseLocale: "en", translations: { de: { legalLinks: { "/legal/imprint": "Impressum" } } } },
};

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
          children: "Anonymous content",
        });
    }),
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
    // From lg, `main` scrolls regular pages; fullWidth and fullPage work surfaces own their scrolling.
    expect(page.main).toContain("lg:overflow-auto lg:[scrollbar-gutter:stable]");
    for (const { main } of [fullWidth, fullPage]) {
      expect(main).toContain("flex flex-col");
      expect(main).not.toContain("scrollbar-gutter");
    }
    // Below lg the document scrolls every page except fullPage surfaces, which the canvas marks.
    expect(page.canvas).not.toContain("data-layout-full-page");
    expect(fullWidth.canvas).not.toContain("data-layout-full-page");
    expect(fullPage.canvas).toContain('data-layout-full-page="true"');
    const css = await Bun.file(new URL("../styles/global.css", import.meta.url)).text();
    const mobileStart = css.indexOf("@media (max-width: 1023px) {");
    const mobileShell = css.slice(mobileStart, css.indexOf("\n}", mobileStart));
    expect(mobileShell).toMatch(/html:has\(\.cloud-app-canvas:not\(\[data-layout-full-page\]\)\) \{ scrollbar-gutter: stable; \}/);
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
    expect(html).toContain("Heller Modus");
    expect(html).toContain("English");
    expect(html).not.toContain("layout-rail-navigation");
    expect(html).not.toContain('data-layout-authenticated="true"');
    expect(html).not.toContain('href="/me"');
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
      expect(html).toContain('aria-haspopup="menu"');
      expect(html).toContain("Dark mode");
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
    expect(html).toContain("Heller Modus");
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
