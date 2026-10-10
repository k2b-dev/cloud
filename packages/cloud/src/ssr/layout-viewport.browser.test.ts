import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { launchBrowser } from "../../../ui/test/browser";

// Whether the document scrolls is a layout result, which happy-dom does not model, so a real engine renders the
// shell with the compiled global stylesheet.
const root = mkdtempSync(resolve(tmpdir(), "cloud-layout-viewport-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { defineApp } = await import("../_internal/define-app");
const { default: Layout } = await import("./Layout");
const { LayoutHelpPage } = await import("./LayoutHelp");

const CONTENT = "layout-viewport-probe-content";
const contents = {
  short: "Content",
  // Much taller than any window. `flex: none` keeps its height in the flex columns of full-width and full-page pages.
  long: `<div style="flex:none;height:3000px">Long content</div>`,
};

type LayoutContextArg = Parameters<typeof Layout>[0]["c"];
const app = defineApp({
  id: "layout-viewport-probe",
  name: "Layout viewport probe",
  icon: "ti ti-layout",
  description: "Renders the shell in each layout mode",
  baseUrl: "http://layout-viewport-probe:3000",
  routes: ["/layout", "/help"],
});
const server = new Hono()
  .use("*", async (c, next) => {
    c.set("runtime" as never, { apps: [] } as never);
    await next();
  })
  .get(
    "/layout",
    ...app.ssr((c) => {
      const mode = c.req.query("mode");
      return () =>
        createComponent(Layout, {
          c: c as unknown as LayoutContextArg,
          fullPage: mode === "fullPage",
          fullWidth: mode === "fullWidth",
          title: "Viewport probe",
          children: CONTENT,
        });
    }),
  )
  // Core's registered Help route renders the Help page on its own, without the shell.
  .get("/help", ...app.ssr(() => () => createComponent(LayoutHelpPage, { documents: [], pageBase: "/help/apps/layout-viewport-probe" })));

let browser: Browser;
let css: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

/**
 * Resolves the classic viewport units the way iPadOS does while its toolbar is shown: `vh` follows the large viewport,
 * here 1370 px in a window 1307 px tall, while the dynamic units keep the window's height. Playwright's engines have no
 * collapsing toolbar, so `vh` always equals `dvh` there; the stylesheet is rewritten to the device's values instead.
 */
const largeViewport = (page: Page, ratio: number) =>
  page.evaluate((ratio) => {
    const vh = (innerHeight * ratio) / 100;
    const rewrite = (value: string) =>
      value.replace(/(?<![a-z-])(-?\d*\.?\d+)vh\b/g, (_, amount: string) => `${(Number(amount) * vh).toFixed(3)}px`);
    const walk = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          for (const property of Array.from(rule.style)) {
            const value = rule.style.getPropertyValue(property);
            const next = rewrite(value);
            if (next !== value) rule.style.setProperty(property, next, rule.style.getPropertyPriority(property));
          }
        }
        if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules);
  }, ratio);

type Viewport = { width: number; height: number };
const open = async (path: string, viewport: Viewport, content = contents.short) => {
  const html = new HTMLRewriter()
    .on("script", { element: (script) => void script.remove() })
    .on('link[rel="stylesheet"]', { element: (link) => void link.remove() })
    .transform(await (await server.request(path)).text())
    .replace(CONTENT, content)
    .replace("</head>", `<style>${css}</style></head>`);
  const page = await browser.newPage({ viewport });
  await page.setContent(html);
  await largeViewport(page, 1370 / 1307);
  return page;
};

const viewports = {
  "an iPad window on an external display": { width: 2307, height: 1307 },
  "an iPad in landscape": { width: 1180, height: 820 },
  "a phone": { width: 390, height: 664 },
};
const modes = ["page", "fullWidth", "fullPage"] as const;

/**
 * What scrolls a long page. From `lg`, a regular page scrolls its content area and a full-width app its own panes, so
 * the window stays put. Below `lg`, regular and full-width pages grow with their content and the document scrolls. A
 * full-page surface never lets the document scroll.
 */
const longPageScroller = (mode: (typeof modes)[number], viewport: Viewport) => {
  if (mode === "fullPage") return "none";
  // Tailwind's `lg` breakpoint.
  if (viewport.width < 1024) return "document";
  return mode === "page" ? "main" : "none";
};

const scrollerNames = { main: "its content area", document: "the document", none: "neither the document nor the content area" };

const measure = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".layout-content-main");
    const scroller = document.scrollingElement!;
    if (main) main.scrollTop = 400;
    scroller.scrollTop = 400;
    return {
      documentHeight: scroller.scrollHeight,
      canvasHeight: Math.round(document.querySelector(".cloud-app-canvas")?.getBoundingClientRect().height ?? 0),
      mainScrolled: (main?.scrollTop ?? 0) > 0,
      documentScrolled: scroller.scrollTop > 0,
    };
  });

describe("the Cloud shell fits the window when the large viewport is taller than the visible one", () => {
  for (const [name, viewport] of Object.entries(viewports)) {
    for (const mode of modes) {
      // A shell sized with the large viewport outgrows the window by the toolbar and lets the page scroll.
      test(`a short ${mode} shell on ${name}`, async () => {
        const page = await open(`/layout?mode=${mode}`, viewport);
        try {
          const { documentHeight, canvasHeight } = await measure(page);
          expect({ documentHeight, canvasHeight }).toEqual({ documentHeight: viewport.height, canvasHeight: viewport.height });
        } finally {
          await page.close();
        }
      }, 30_000);

      const scroller = longPageScroller(mode, viewport);
      test(`a long ${mode} shell on ${name} scrolls ${scrollerNames[scroller]}`, async () => {
        const page = await open(`/layout?mode=${mode}`, viewport, contents.long);
        try {
          const { documentHeight, mainScrolled, documentScrolled } = await measure(page);
          expect({ mainScrolled, documentScrolled }).toEqual({
            mainScrolled: scroller === "main",
            documentScrolled: scroller === "document",
          });
          if (scroller === "document") expect(documentHeight).toBeGreaterThan(3000);
          else expect(documentHeight).toBe(viewport.height);
        } finally {
          await page.close();
        }
      }, 30_000);
    }

    test(`the standalone Help page on ${name}`, async () => {
      const page = await open("/help", viewport);
      try {
        expect((await measure(page)).documentHeight).toBe(viewport.height);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});
