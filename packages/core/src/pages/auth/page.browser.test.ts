import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as cloud from "@k2b/cloud";
import { DEFAULT_ACCOUNT_CATEGORY_POLICY } from "@k2b/cloud/contracts";
import * as services from "@k2b/cloud/services";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import { type Browser, chromium } from "playwright";

// Whether the sign-in card is a frame or flat is decided by the cascade
// between Tailwind utilities, @k2b/ui and Cloud styles at a viewport width,
// which only a real engine resolves.
const root = mkdtempSync(join(tmpdir(), "core-login-page-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");
// Text and icon widths decide where rows wrap, so the page gets its real fonts.
const { buildFontAssets } = await import("../../../scripts/font-assets");
const { buildTablerIconAssets } = await import("../../../scripts/tabler-assets");
const publicDir = join(root, "public");
const origin = "https://cloud.example.test";

const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  spies.push(
    spyOn(services.coreSettings, "get").mockImplementation(
      async (key) => (key === "freeipa.enable" ? true : key === "app.contact_email" ? "help@cloud.example.test" : undefined) as never,
    ),
    spyOn(services, "readAccountCategoryPolicy").mockResolvedValue(DEFAULT_ACCOUNT_CATEGORY_POLICY),
    spyOn(cloud, "listLegalLinks").mockResolvedValue([
      { label: "Imprint", href: "/legal/imprint" },
      { label: "Privacy", href: "/legal/privacy" },
    ] as never),
    spyOn(services.appApproval, "config").mockResolvedValue({
      issuer: "https://cloud.example.test",
      appOrigin: "https://auth.example.test",
      enabled: true,
      adminPairing: false,
    }),
  );
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

let browser: Browser;
let css: string;
beforeAll(async () => {
  // As the page template does: the layer order first, then Core's stylesheet, then the global one.
  const styles = [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(built.map((build) => build.outputs[0]!.text()))),
  ].join("\n");
  await buildFontAssets(publicDir);
  await buildTablerIconAssets(publicDir);
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

/** The server-rendered sign-in page body, as it arrives before any script runs. */
const body = async (query: string, locale: string) => {
  const app = new Hono().get("/auth/login", ...handler);
  const response = await app.request(`https://cloud.example.test/auth/login${query}`, { headers: { Cookie: `cloud.locale=${locale}` } });
  expect(response.status).toBe(200);
  const html = await response.text();
  return /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, "");
};

type View = { width: number; height: number; touch: boolean };
const measure = async (view: View, query: string, options: { locale?: "en" | "de"; dark?: boolean } = {}) => {
  const tab = await browser.newPage({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 2,
    isMobile: view.touch,
    hasTouch: view.touch,
  });
  try {
    await tab.route(`${origin}/public/**`, (route) => route.fulfill({ path: join(root, new URL(route.request().url()).pathname) }));
    await tab.setContent(
      `<!doctype html><html lang="en" class="${options.dark ? "dark" : "light"}"><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<link rel="stylesheet" href="${origin}/public/fonts.css"><link rel="stylesheet" href="${origin}/public/tabler-icons.css"><style>${css}</style></head>` +
        `<body class="k2b-ui">${await body(query, options.locale ?? "en")}</body></html>`,
    );
    await tab.evaluate(() => document.fonts.ready);
    return await tab.evaluate(() => {
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const card = document.querySelector(".standalone-card")!;
      const style = getComputedStyle(card);
      return {
        surface: {
          border: style.borderTopWidth,
          radius: style.borderTopLeftRadius,
          shadow: style.boxShadow,
          background: style.backgroundColor,
        },
        aside: getComputedStyle(document.querySelector("aside")!).display,
        fields: Array.from(document.querySelectorAll("main .k2b-input-shell")).map(box),
        actions: Array.from(document.querySelectorAll(".auth-secondary-actions :is(a, button)")).map((action) => ({
          name: action.textContent?.trim() ?? "",
          ...box(action),
        })),
        // The page without its centering slack: where the footer ends, plus the page padding.
        contentHeight: box(document.querySelector("footer")!).bottom - box(card).top + 32,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      };
    });
  } finally {
    await tab.close();
  }
};

// An iPhone 14 with Safari's toolbars showing.
const phone = { width: 390, height: 664, touch: true };
const desktop = { width: 1440, height: 900, touch: false };
const forms = {
  password: "?method=ipa",
  app: "?method=ipa&credential=app",
  guest: "?method=guest",
  login: "?method=login&credential=legacy",
};
const flat = { border: "0px", radius: "0px", shadow: "none", background: "rgba(0, 0, 0, 0)" };

describe("sign-in page in a browser", () => {
  test("is flat on a phone and fits the first screen for every account type, form and language", async () => {
    for (const [form, query] of Object.entries(forms)) {
      for (const locale of ["en", "de"] as const) {
        for (const view of [phone, { ...phone, width: 320 }]) {
          const context = `${form} ${locale} ${view.width}`;
          const page = await measure(view, query, { locale, dark: locale === "de" });
          expect(page.surface, context).toEqual(flat);
          expect(page.aside, context).toBe("none");
          expect(page.scrollWidth, context).toBeLessThanOrEqual(view.width);
          expect(page.fields.length, context).toBeGreaterThan(0);
          // Fields span the viewport minus the page padding of 16 px on each side.
          for (const field of page.fields) expect([field.left, field.right], context).toEqual([16, view.width - 16]);
          expect(page.contentHeight, context).toBeLessThanOrEqual(view.height);
          expect(page.scrollHeight, context).toBe(view.height);
        }
      }
    }
  }, 120_000);

  test("lays the secondary actions out as an even grid where the form column is narrow", async () => {
    for (const locale of ["en", "de"] as const) {
      for (const width of [390, 320]) {
        const context = `${locale} ${width}`;
        const { actions } = await measure({ ...phone, width }, forms.password, { locale });
        const [support, passkey, admin] = actions;
        expect(actions.map((action) => action.name)).toEqual(
          locale === "en" ? ["Contact support", "Use passkey", "Admin token"] : ["Support kontaktieren", "Mit Passkey", "Admin-Token"],
        );
        // The passkey takes the first row; support and the admin token share the second as equal halves.
        expect([passkey!.left, passkey!.right], context).toEqual([16, width - 16]);
        expect(support!.top, context).toBeGreaterThanOrEqual(passkey!.bottom + 10);
        expect([support!.top, support!.width], context).toEqual([admin!.top, admin!.width]);
        expect([support!.left, admin!.right], context).toEqual([16, width - 16]);
        expect(admin!.left - support!.right, context).toBe(8);
        for (const action of actions) expect(action.height, `${context} ${action.name}`).toBeGreaterThanOrEqual(36);
      }
    }
  }, 60_000);

  test("keeps the card from the tablet width up and the single action row in a wide form column", async () => {
    // The two-column card of a small tablet has a narrow form column and the same even grid as a phone.
    const tablet = await measure({ width: 768, height: 1024, touch: true }, forms.password, { locale: "de" });
    expect([tablet.surface.border, tablet.surface.radius, tablet.aside]).toEqual(["1px", "16px", "flex"]);
    expect(tablet.actions[0]!.top).toBe(tablet.actions[2]!.top);
    expect(tablet.actions[1]!.bottom).toBeLessThan(tablet.actions[0]!.top);

    for (const view of [desktop, { width: 1024, height: 768, touch: true }]) {
      const context = `${view.width}`;
      const page = await measure(view, forms.password);
      expect(page.surface, context).toEqual({
        border: "1px",
        radius: "16px",
        shadow: expect.stringContaining("rgba(24, 24, 27, 0.12) 0px 16px 48px 0px"),
        background: "rgb(255, 255, 255)",
      });
      expect(page.aside, context).toBe("flex");
      expect(page.scrollWidth, context).toBeLessThanOrEqual(view.width);
      const [support, passkey, admin] = page.actions;
      expect(new Set(page.actions.map((action) => action.height)).size, context).toBe(1);
      expect(support!.right, context).toBeLessThan(passkey!.left);
      expect(passkey!.right, context).toBeLessThan(admin!.left);
      expect(Math.abs(support!.top - admin!.top), context).toBeLessThan(1);
    }
    expect((await measure(desktop, forms.password)).fields.map((field) => field.width)).toEqual([448, 448]);
  }, 60_000);
});
