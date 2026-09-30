import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import { type Browser, chromium } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

// Where the footer lands depends on the cascade between Cloud and @k2b/ui
// styles and on the page around it, which only a real engine shows.
const root = mkdtempSync(resolve(tmpdir(), "cloud-minimal-layout-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MinimalLayout } = await import("./MinimalLayout");
type MinimalLayoutContextArg = Parameters<typeof MinimalLayout>[0]["c"];

const legalApp = {
  id: "legal-probe",
  legalLinks: [
    { label: "Imprint", href: "/legal/imprint" },
    { label: "Privacy", href: "/legal/privacy" },
  ],
};

const CONTENT = "minimal-layout-probe-content";
const pages = {
  // A public share: one card, no height of its own.
  short: `<main style="width:100%;max-width:42rem;margin:0 auto;padding:2.5rem 1rem"><div style="height:12rem">Card</div></main>`,
  // A centered unlock or error page that fills the space above the footer.
  fill: `<main style="flex:1;display:flex;align-items:center;justify-content:center;padding:2rem 1rem"><div style="width:18rem;height:16rem">Card</div></main>`,
  // A long form.
  long: `<main style="height:2000px">Form</main>`,
  // An app surface such as the Assistant runner that scrolls inside.
  app: `<main style="display:flex;flex:1 1 0;min-height:0;overflow:hidden"><div style="overflow:auto"><div style="height:3000px">Runner</div></div></main>`,
} as const;

const render = (page: keyof typeof pages) => {
  const context = {
    get: (key: string) => (key === "page" ? {} : key === "runtime" ? { apps: [legalApp] } : undefined),
    req: { raw: { headers: new Headers({ "Accept-Language": "en" }), url: "https://cloud.test/share/probe" } },
  } as unknown as MinimalLayoutContextArg;
  return renderToString(() => createComponent(MinimalLayout, { c: context, children: CONTENT })).replace(CONTENT, pages[page]);
};

let browser: Browser;
let css: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const viewports = [
  { name: "phone", width: 390, height: 664, isMobile: true, hasTouch: true, minTarget: 44 },
  { name: "narrow phone", width: 320, height: 568, isMobile: true, hasTouch: true, minTarget: 44 },
  { name: "desktop", width: 1440, height: 900, isMobile: false, hasTouch: false, minTarget: 28 },
] as const;

const measure = async (viewport: (typeof viewports)[number], page: keyof typeof pages) => {
  const tab = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    isMobile: viewport.isMobile,
    hasTouch: viewport.hasTouch,
  });
  try {
    await tab.setContent(
      `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
        `<body class="k2b-ui">${render(page)}</body></html>`,
    );
    return await tab.evaluate(() => {
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const footer = document.querySelector("footer")!;
      // The closed language menu is rendered but hidden.
      const visible = Array.from(footer.querySelectorAll("a[href], button")).filter((control) => control.checkVisibility());
      const controls = visible.map((control) => {
        const rect = control.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          name: control.getAttribute("aria-label") ?? control.textContent?.trim() ?? "",
          box: box(control),
          reachable: hit === control || control.contains(hit),
        };
      });
      return {
        footer: box(footer),
        main: box(document.querySelector("main")!),
        controls,
        position: getComputedStyle(footer).position,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
  } finally {
    await tab.close();
  }
};

describe("MinimalLayout footer in a browser", () => {
  for (const viewport of viewports) {
    test(`stays in flow, inside the viewport, and finger-sized on ${viewport.name}`, async () => {
      for (const page of ["short", "fill", "long", "app"] as const) {
        const { footer, main, controls, position, scrollWidth } = await measure(viewport, page);
        const context = `${viewport.name} ${page}`;

        expect(position, context).toBe("static");
        expect(scrollWidth, context).toBeLessThanOrEqual(viewport.width);
        expect(footer.left, context).toBeGreaterThanOrEqual(0);
        expect(footer.right, context).toBeLessThanOrEqual(viewport.width);
        // The footer follows the content and never covers it.
        expect(footer.top, context).toBeGreaterThanOrEqual(main.bottom - 0.5);
        if (page === "long") expect(footer.top, context).toBeGreaterThanOrEqual(2000);
        // Other pages end with the footer at the bottom of the first screen.
        else expect(Math.abs(footer.bottom - viewport.height), context).toBeLessThan(1);

        expect(controls.map((control) => control.name)).toEqual(["Imprint", "Privacy", "Language: English", "Dark mode"]);
        for (const control of controls) {
          const name = `${context} ${control.name}`;
          expect(control.box.left, name).toBeGreaterThanOrEqual(0);
          expect(control.box.right, name).toBeLessThanOrEqual(viewport.width);
          expect(control.box.height, name).toBeGreaterThanOrEqual(viewport.minTarget);
          if (page !== "long") expect(control.reachable, name).toBe(true);
        }
        for (const [index, a] of controls.entries()) {
          for (const b of controls.slice(index + 1)) {
            const overlap =
              Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left) > 0.5 &&
              Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top) > 0.5;
            expect(overlap, `${context} ${a.name} / ${b.name}`).toBe(false);
          }
        }
      }
    }, 30_000);
  }
});

// The one card of a standalone page, as the public pages of Mail and Grids build it.
const { Paper, TextInput } = await import("@k2b/ui");
const field = () => createComponent(TextInput, { label: "Password", value: "", password: true });
const cards = {
  // An elevated @k2b/ui Paper centered above the footer, with more padding from `sm` up.
  paper: (surface: string) =>
    `<main class="flex flex-1 items-center justify-center px-4 py-8">${renderToString(() =>
      createComponent(Paper, { as: "section" as const, elevated: true, class: `${surface} w-full max-w-md p-6 sm:p-8`, children: field() }),
    )}</main>`,
  // A plain @k2b/ui Paper at the top of a share page.
  plain: (surface: string) =>
    `<main class="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-10">${renderToString(() =>
      createComponent(Paper, { as: "section" as const, class: `${surface} flex flex-col gap-4 p-6`, children: field() }),
    )}</main>`,
  // The Cloud `paper` utility at the top of a form page.
  utility: (surface: string) =>
    `<main class="mx-auto w-full max-w-2xl px-4 py-6"><section class="paper ${surface} p-6">${renderToString(field)}</section></main>`,
} as const;

const measureCard = async (width: number, card: keyof typeof cards, surface: string, theme: "light" | "dark") => {
  const tab = await browser.newPage({ viewport: { width, height: 664 }, isMobile: width < 768, hasTouch: width < 768 });
  try {
    const context = {
      get: (key: string) => (key === "page" ? {} : key === "runtime" ? { apps: [legalApp] } : undefined),
      req: { raw: { headers: new Headers({ "Accept-Language": "en" }), url: "https://cloud.test/share/probe" } },
    } as unknown as MinimalLayoutContextArg;
    const html = renderToString(() => createComponent(MinimalLayout, { c: context, children: CONTENT })).replace(
      CONTENT,
      cards[card](surface),
    );
    await tab.setContent(
      `<!doctype html><html lang="en" class="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
        `<body class="k2b-ui">${html}</body></html>`,
    );
    return await tab.evaluate(() => {
      const section = document.querySelector("section")!;
      const style = getComputedStyle(section);
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      };
      return {
        surface: {
          border: style.borderTopWidth,
          radius: style.borderTopLeftRadius,
          shadow: style.boxShadow,
          background: style.backgroundColor,
          padding: style.paddingTop,
        },
        card: box(section),
        input: box(document.querySelector(".k2b-input-shell")!),
        footer: box(document.querySelector("footer")!),
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
  } finally {
    await tab.close();
  }
};

describe("standalone card in a browser", () => {
  const flat = { border: "0px", radius: "0px", shadow: "none", background: "rgba(0, 0, 0, 0)", padding: "0px" };

  test("is flat on a phone: the content sits on the page with the page padding", async () => {
    for (const theme of ["light", "dark"] as const) {
      for (const card of ["paper", "plain", "utility"] as const) {
        for (const width of [390, 767]) {
          const context = `${theme} ${card} ${width}`;
          const measured = await measureCard(width, card, "standalone-card", theme);
          expect(measured.surface, context).toEqual(flat);
          expect(measured.scrollWidth, context).toBeLessThanOrEqual(width);
          if (width === 390) {
            // Fields span the viewport minus the page padding of 16 px on each side.
            expect([measured.input.left, measured.input.right], context).toEqual([16, 374]);
          }
          // The footer keeps its place at the end of the first screen.
          expect(Math.abs(measured.footer.bottom - 664), context).toBeLessThan(1);
        }
      }
    }
  }, 60_000);

  test("keeps the card from the tablet width up, exactly like a card without the class", async () => {
    for (const theme of ["light", "dark"] as const) {
      for (const card of ["paper", "plain", "utility"] as const) {
        for (const width of [768, 1440]) {
          const context = `${theme} ${card} ${width}`;
          const measured = await measureCard(width, card, "standalone-card", theme);
          expect(measured.surface.border, context).toBe("1px");
          expect(measured.surface.padding, context).toBe(card === "paper" ? "32px" : "24px");
          expect(measured.surface.radius, context).not.toBe("0px");
          expect(measured.surface.background, context).not.toBe(flat.background);
          expect(measured, context).toEqual(await measureCard(width, card, "", theme));
        }
      }
    }
  }, 60_000);
});

// A public share as the page template delivers it: head, stylesheets and fonts included.
const { defineApp } = await import("../_internal/define-app");
const { Button } = await import("@k2b/ui");
const shareApp = defineApp({
  id: "minimal-layout-probe",
  name: "Minimal Layout Probe",
  icon: "ti ti-share",
  description: "MinimalLayout first-frame probe",
  baseUrl: "http://minimal-layout-probe:3000",
  routes: ["/share/minimal-layout-probe"],
});
const shareServer = new Hono().get(
  "/share/minimal-layout-probe",
  ...shareApp.ssr((c) => () => {
    const context = {
      get: (key: string) => (key === "runtime" ? { apps: [legalApp] } : c.get(key as "page")),
      req: c.req,
    } as unknown as MinimalLayoutContextArg;
    return createComponent(MinimalLayout, { c: context, children: CONTENT });
  }),
);
// Headings, running text and a button: the three weights, in lines that wrap differently in another font.
const share =
  `<main class="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-10"><section class="paper standalone-card flex flex-col gap-4 p-6">` +
  `<h1 class="text-lg font-semibold">Signed contracts and the quarterly report for the supervisory board</h1>` +
  `<p class="text-sm">Available until 31 October. Download the files you need before the link expires; uploads to this share are not possible.</p>` +
  `${renderToString(() => createComponent(Button, { variant: "primary", children: "Download all files" }))}</section></main>`;

const uiDist = dirname(fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css")));
/** The font assets Core serves, derived from the @k2b/ui presets as Core's build does. */
const coreAssets = async () => {
  const icons = await Bun.file(resolve(uiDist, "tabler.css")).text();
  return {
    stylesheets: {
      "/public/fonts.css": (await Bun.file(resolve(uiDist, "plex.css")).text()).replaceAll("./fonts/", "/public/fonts/"),
      "/public/tabler-icons.css": icons.replace(/\.\/tabler-icons-[\w-]+\.woff2(\?[^)]*)?/, "/public/tabler-icons.woff2"),
      "/public/global.css": css,
    } as Record<string, string>,
    file: (pathname: string) =>
      pathname === "/public/tabler-icons.woff2"
        ? resolve(uiDist, /tabler-icons-[\w-]+\.woff2/.exec(icons)![0])
        : pathname.startsWith("/public/fonts/")
          ? resolve(uiDist, "fonts", pathname.slice("/public/fonts/".length))
          : null,
  };
};

/** Every element's box in the first frame after DOMContentLoaded and after load, plus Chromium's layout shifts. */
const firstFrameAndLoad = async (viewport: (typeof viewports)[number]) => {
  const origin = "https://cloud.test";
  const html = (await (await shareServer.request(`${origin}/share/minimal-layout-probe`)).text()).replace(CONTENT, share);
  const { stylesheets, file } = await coreAssets();
  const preloads = [...html.matchAll(/<link rel="preload" href="([^"]+)" as="font"/g)].map((match) => match[1]!);
  // Serve the stylesheets once every preloaded font is served, the order a preload allows; without a preload
  // the fonts are only requested after layout, and the stylesheets go out after a pause instead.
  const served = new Map(preloads.map((href) => [href, Promise.withResolvers<void>()]));
  const fontsFirst = Promise.race([Promise.all([...served.values()].map((font) => font.promise)), Bun.sleep(2_000)]);
  const tab = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    isMobile: viewport.isMobile,
    hasTouch: viewport.hasTouch,
  });
  try {
    await tab.route(`${origin}/**`, async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/share/minimal-layout-probe") return route.fulfill({ contentType: "text/html", body: html });
      const stylesheet = stylesheets[pathname];
      if (stylesheet !== undefined) {
        await fontsFirst;
        return route.fulfill({ contentType: "text/css", body: stylesheet });
      }
      const path = file(pathname);
      if (!path) return route.fulfill({ status: 404, body: "" });
      await route.fulfill({ path });
      served.get(pathname)?.resolve();
    });
    // The islands' scripts answer 404, so only the fonts can move anything.
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
    await tab.goto(`${origin}/share/minimal-layout-probe`, { waitUntil: "load" });
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

describe("standalone page load in a browser", () => {
  test("shows its final layout in the first frame instead of moving when the fonts arrive", async () => {
    for (const viewport of viewports) {
      const page = await firstFrameAndLoad(viewport);
      expect(page.fonts, viewport.name).toEqual(expect.arrayContaining(["IBM Plex Sans 400", "IBM Plex Sans 500", "IBM Plex Sans 600"]));
      expect(page.loaded, viewport.name).toEqual(page.firstFrame);
      expect(page.shifts, viewport.name).toEqual([]);
    }
  }, 60_000);
});
