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

type LayoutContextArg = Parameters<typeof Layout>[0]["c"];
const app = defineApp({
  id: "layout-viewport-probe",
  name: "Layout viewport probe",
  icon: "ti ti-layout",
  description: "Renders the shell in each layout mode",
  baseUrl: "http://layout-viewport-probe:3000",
  routes: ["/layout"],
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
          children: "Content",
        });
    }),
  );

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
 * Resolves the classic viewport units the way iPadOS does once its toolbar collapses: `vh` follows the large viewport,
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

const shell = async (mode: string, viewport: { width: number; height: number }) => {
  const html = (await (await server.request(`/layout?mode=${mode}`)).text())
    .replace(/<script\b[\s\S]*?<\/script>/g, "")
    .replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, "")
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

describe("the Cloud shell fits the window when the large viewport is taller than the visible one", () => {
  for (const [name, viewport] of Object.entries(viewports)) {
    for (const mode of ["page", "fullWidth", "fullPage"]) {
      // A shell sized with the large viewport outgrows the window by the collapsed toolbar and lets the page scroll.
      test(`a ${mode} shell on ${name}`, async () => {
        const page = await shell(mode, viewport);
        try {
          const fit = await page.evaluate(() => ({
            documentHeight: document.documentElement.scrollHeight,
            canvasHeight: Math.round(document.querySelector(".cloud-app-canvas")!.getBoundingClientRect().height),
          }));
          expect(fit).toEqual({ documentHeight: viewport.height, canvasHeight: viewport.height });
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  }
});
