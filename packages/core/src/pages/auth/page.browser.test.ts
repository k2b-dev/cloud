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
    // All three legal pages, as Core lists them: with the language switch, the German footer takes two rows on a phone.
    spyOn(cloud, "listLegalLinks").mockImplementation(async (locale) =>
      (locale === "de" ? ["Impressum", "Datenschutz", "Nutzungsbedingungen"] : ["Imprint", "Privacy", "Terms"]).map((label, index) => ({
        label,
        href: ["/impressum", "/legal/privacy", "/legal/terms"][index]!,
      })),
    ),
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
let stylesheets: Record<string, string>;
beforeAll(async () => {
  // As the page template does: the layer order first, then Core's stylesheet, then the global one.
  const styles = [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss].join("\n");
  await buildFontAssets(publicDir);
  await buildTablerIconAssets(publicDir);
  // The stylesheets the page template links, by path.
  stylesheets = {
    "/public/fonts.css": await Bun.file(join(publicDir, "fonts.css")).text(),
    "/public/tabler-icons.css": await Bun.file(join(publicDir, "tabler-icons.css")).text(),
    "/public/core/app.css": appCss!,
    "/public/global.css": globalCss!,
  };
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

/** The server-rendered sign-in document. */
const serverDocument = async (query: string, locale: string) => {
  const app = new Hono().get("/auth/login", ...handler);
  const response = await app.request(`https://cloud.example.test/auth/login${query}`, { headers: { Cookie: `cloud.locale=${locale}` } });
  expect(response.status).toBe(200);
  return await response.text();
};

/** The server-rendered sign-in page body. */
const body = async (query: string, locale: string) => /<body[^>]*>([\s\S]*)<\/body>/.exec(await serverDocument(query, locale))![1]!;

type View = { width: number; height: number; touch: boolean };
type Options = { locale?: "en" | "de"; dark?: boolean; defaultFontSize?: number };
/** A tab with the server-rendered page as it arrives, before any page script runs; the caller closes it. */
const open = async (view: View, query: string, options: Options = {}) => {
  const tab = await browser.newPage({
    javaScriptEnabled: false,
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 2,
    isMobile: view.touch,
    hasTouch: view.touch,
  });
  // A larger default font in the browser settings, which also moves rem-based breakpoints.
  if (options.defaultFontSize) {
    const session = await tab.context().newCDPSession(tab);
    await session.send("Page.setFontSizes", { fontSizes: { standard: options.defaultFontSize } });
  }
  await tab.route(`${origin}/public/**`, (route) => route.fulfill({ path: join(root, new URL(route.request().url()).pathname) }));
  await tab.setContent(
    `<!doctype html><html lang="en" class="${options.dark ? "dark" : "light"}"><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<link rel="stylesheet" href="${origin}/public/fonts.css"><link rel="stylesheet" href="${origin}/public/tabler-icons.css"><style>${css}</style></head>` +
      `<body class="k2b-ui">${await body(query, options.locale ?? "en")}</body></html>`,
  );
  await tab.evaluate(() => document.fonts.ready);
  return tab;
};

/** The boxes and styles the layout checks need, as the server response renders them. */
const measure = async (view: View, query: string, options: Options = {}) => {
  const tab = await open(view, query, options);
  try {
    return await tab.evaluate(() => {
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const card = document.querySelector(".standalone-card")!;
      const style = getComputedStyle(card);
      // The rows along a link's center line where a tap reaches that link.
      const hitRows = (link: Element) => {
        const rect = link.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const rows: number[] = [];
        for (let y = Math.floor(rect.top) - 30; y <= rect.bottom + 30; y++) {
          const hit = document.elementFromPoint(x, y);
          if (hit && (hit === link || link.contains(hit))) rows.push(y);
        }
        return {
          top: Math.min(...rows),
          bottom: Math.max(...rows) + 1,
          contiguous: rows.length === Math.max(...rows) + 1 - Math.min(...rows),
        };
      };
      const reset = document.querySelector(".auth-reset-link");
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
        textLinks: [...(reset ? [reset] : []), ...Array.from(document.querySelectorAll(".auth-footer-link"))].map((link) => ({
          name: link.textContent?.trim() ?? "",
          ...box(link),
          hit: hitRows(link),
        })),
        submit: Array.from(document.querySelectorAll("main button[type=submit]")).map(box),
        languageSwitch: box(document.querySelector(".auth-language-trigger")!),
        cardTop: box(card).top,
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

/**
 * Every element's box in the first frame after DOMContentLoaded and once the page and its fonts have loaded,
 * plus Chromium's layout-shift entries. The tab loads the complete server response with the stylesheets and
 * fonts its template links; the islands' scripts are left out, so only the fonts can move anything.
 */
const firstFrameAndLoad = async (view: View, query: string, locale: "en" | "de") => {
  const html = await serverDocument(query, locale);
  // The template preloads the faces that Core's font stylesheet names, under the same URLs.
  const preloads = [...html.matchAll(/<link rel="preload" href="([^"]+)" as="font"/g)].map((match) => match[1]!);
  for (const href of preloads.filter((href) => href.startsWith("/public/fonts/")))
    expect(stylesheets["/public/fonts.css"]).toContain(`url(${href})`);
  // A preload makes the fonts download next to the stylesheets. Answering the stylesheets only once every
  // preloaded font is served makes that order deterministic, however slow the runner; a face without a preload
  // is only requested after the stylesheets and layout, so the first frame shows the fallback font.
  const served = new Map(preloads.map((href) => [href, Promise.withResolvers<void>()]));
  const fontsFirst = Promise.all([...served.values()].map((font) => font.promise));
  const tab = await browser.newPage({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 2,
    isMobile: view.touch,
    hasTouch: view.touch,
  });
  try {
    await tab.route(`${origin}/**`, async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/auth/login") return route.fulfill({ contentType: "text/html", body: html });
      const stylesheet = stylesheets[pathname];
      if (stylesheet !== undefined) {
        await fontsFirst;
        return route.fulfill({ contentType: "text/css", body: stylesheet });
      }
      if (!pathname.startsWith("/public/")) return route.fulfill({ status: 404, body: "" });
      await route.fulfill({ path: join(root, pathname) });
      served.get(pathname)?.resolve();
    });
    await tab.addInitScript(() => {
      const state = window as unknown as { firstFrame?: string[]; shifts: number[]; boxes: () => string[] };
      state.shifts = [];
      state.boxes = () =>
        Array.from(document.body.querySelectorAll("*")).map((element) => {
          const { left, top, width, height } = element.getBoundingClientRect();
          return `${element.tagName.toLowerCase()}.${element.classList[0] ?? ""} "${element.textContent?.trim().slice(0, 24)}" ${left},${top} ${width}x${height}`;
        });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.shifts.push((entry as PerformanceEntry & { value: number }).value);
      }).observe({ type: "layout-shift", buffered: true });
      document.addEventListener("DOMContentLoaded", () => requestAnimationFrame(() => (state.firstFrame = state.boxes())));
    });
    await tab.goto(`${origin}/auth/login${query}`, { waitUntil: "load" });
    await tab.waitForFunction(() => "firstFrame" in window);
    return await tab.evaluate(async () => {
      await document.fonts.ready;
      const state = window as unknown as { firstFrame: string[]; shifts: number[]; boxes: () => string[] };
      const fonts: string[] = [];
      document.fonts.forEach((font) => {
        if (font.status === "loaded") fonts.push(`${font.family} ${font.weight}`);
      });
      return { firstFrame: state.firstFrame, loaded: state.boxes(), shifts: state.shifts, fonts };
    });
  } finally {
    await tab.close();
  }
};

/** The names keyboard focus reaches after the "use the app instead" link. */
const tabOrder = async (view: View, query: string, steps: number) => {
  const tab = await open(view, query);
  try {
    await tab.focus(".auth-login-alternative");
    const names: string[] = [];
    for (let step = 0; step < steps; step++) {
      await tab.keyboard.press("Tab");
      names.push(await tab.evaluate(() => document.activeElement?.textContent?.trim() ?? ""));
    }
    return names;
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

  test("grows and scrolls instead of clipping when the password form shows a notice", async () => {
    // The banner is the same NoticeCard in the same place as a failed sign-in's error.
    for (const locale of ["en", "de"] as const) {
      const page = await measure(phone, `${forms.password}&banner=true`, { locale });
      expect(page.scrollHeight, locale).toBeGreaterThan(phone.height);
      // The card starts at the page padding and the document ends one padding below the footer.
      expect(page.cardTop, locale).toBe(16);
      expect(Math.abs(page.contentHeight - page.scrollHeight), locale).toBeLessThan(1);
      expect(page.scrollWidth, locale).toBeLessThanOrEqual(phone.width);
      for (const field of page.fields) expect([field.left, field.right], locale).toEqual([16, phone.width - 16]);
    }
  }, 60_000);

  test("gives the small text links finger-sized hit areas that stop short of their neighbours", async () => {
    for (const locale of ["en", "de"] as const) {
      const page = await measure(phone, forms.password, { locale });
      const [reset, ...footer] = page.textLinks;
      expect([reset!.name, ...footer.map((link) => link.name)], locale).toEqual([
        ...(locale === "en"
          ? ["Reset password", "Imprint", "Privacy", "Terms"]
          : ["Passwort zurücksetzen", "Impressum", "Datenschutz", "Nutzungsbedingungen"]),
      ]);
      for (const link of footer) {
        expect(link.hit.contiguous, `${locale} ${link.name}`).toBe(true);
        // The German footer wraps: the language switch takes a second row, 4 px below the links, and its own
        // hit area wins where they meet. The link right above it keeps the 24 px of WCAG's minimum target size;
        // 44 px would push the switch about 18 px down, and the German password form has 2 px left.
        const aboveSwitch =
          link.left < page.languageSwitch.right && link.right > page.languageSwitch.left && link.bottom <= page.languageSwitch.top;
        expect(link.hit.bottom - link.hit.top, `${locale} ${link.name}`).toBeGreaterThanOrEqual(aboveSwitch ? 24 : 44);
      }
      // Only that one link gets the smaller target.
      expect(
        footer.filter((link) => link.hit.bottom - link.hit.top < 44).map((link) => link.name),
        locale,
      ).toEqual(locale === "de" ? ["Datenschutz"] : []);
      // The footer links' hit areas reach 14 px up and stop short of the secondary actions', which reach 4 px down.
      const actionsBottom = Math.max(...page.actions.map((action) => action.bottom));
      for (const link of footer) expect(link.hit.top, `${locale} ${link.name}`).toBeGreaterThanOrEqual(actionsBottom + 4);
      expect(
        footer.filter((link) => link.bottom <= page.languageSwitch.top).length,
        `${locale}: links in a row above the language switch`,
      ).toBe(locale === "de" ? 3 : 0);
      // The reset link sits between the password field and the sign-in button.
      const password = page.fields.at(-1)!;
      const submit = page.submit[0]!;
      expect(reset!.hit.contiguous, locale).toBe(true);
      expect(reset!.hit.bottom - reset!.hit.top, locale).toBeGreaterThanOrEqual(30);
      expect(reset!.hit.top, locale).toBeGreaterThan(password.bottom);
      expect(reset!.hit.bottom, locale).toBeLessThan(submit.top - 2);
    }
    // A mouse keeps the link's own box.
    const [reset] = (await measure(desktop, forms.password)).textLinks;
    expect(reset!.hit.bottom - reset!.hit.top).toBeLessThanOrEqual(Math.ceil(reset!.height) + 1);
  }, 60_000);

  test("shows its final layout in the first frame instead of moving when the fonts arrive", async () => {
    for (const view of [phone, desktop]) {
      for (const locale of ["en", "de"] as const) {
        const context = `${view.width} ${locale}`;
        const page = await firstFrameAndLoad(view, forms.password, locale);
        expect(page.fonts, context).toEqual(expect.arrayContaining(["IBM Plex Sans 400", "IBM Plex Sans 500", "IBM Plex Sans 600"]));
        expect(page.loaded, context).toEqual(page.firstFrame);
        expect(page.shifts, context).toEqual([]);
      }
    }
  }, 60_000);

  test("moves focus through the action grid row by row", async () => {
    expect(await tabOrder(phone, forms.password, 3)).toEqual(["Use passkey", "Contact support", "Admin token"]);
    expect(await tabOrder(desktop, forms.password, 3)).toEqual(["Contact support", "Use passkey", "Admin token"]);
  }, 30_000);

  test("switches at the same rem breakpoint as the page's own md: layout with a larger default font", async () => {
    // With a 20 px default font, md starts at 960 px: at 800 px the page is a phone page throughout,
    // and the form column keeps its 28rem (560 px) width centered on the flat page.
    const narrow = await measure({ width: 800, height: 1024, touch: true }, forms.password, { defaultFontSize: 20 });
    expect([narrow.surface, narrow.aside]).toEqual([flat, "none"]);
    for (const field of narrow.fields) expect([field.left, field.right]).toEqual([120, 680]);
    const wide = await measure({ width: 1000, height: 1024, touch: true }, forms.password, { defaultFontSize: 20 });
    expect([wide.surface.border, wide.surface.radius, wide.aside]).toEqual(["1px", "20px", "flex"]);
  }, 30_000);
});
