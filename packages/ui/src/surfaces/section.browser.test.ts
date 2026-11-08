import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";

// Which rule wins and how large a hit area is are cascade and layout questions, so a real engine renders them.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-section-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Section } = await import("./Section");
const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const markup = renderToString(() => [
  createComponent(Section, {
    id: "page",
    size: "md",
    icon: "ti ti-alert-circle",
    title: "Payment",
    tone: "danger",
    meta: "Failed",
    children: "…",
  }),
  createComponent(Section, { id: "panel", icon: "ti ti-alert-circle", title: "Payment", tone: "danger", meta: "Failed", children: "…" }),
  createComponent(Section, {
    id: "flat",
    frame: "none",
    icon: "ti ti-palette",
    title: "Appearance",
    collapsible: true,
    children: "Fields",
  }),
]);

describe("Section in a real engine", () => {
  test("a tone colors the title of a page section and of a panel section alike", async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
    try {
      await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui">${markup}</body></html>`);
      await settled(page);
      const colors = await page.evaluate(() => {
        const color = (selector: string) => getComputedStyle(document.querySelector(selector)!).color;
        const probe = document.body.appendChild(document.createElement("span"));
        probe.style.color = "var(--k2b-danger-text)";
        const danger = getComputedStyle(probe).color;
        probe.remove();
        return { danger, page: color("#page .k2b-section__title"), panel: color("#panel .k2b-section__title") };
      });
      expect(colors.page).toBe(colors.danger);
      expect(colors.panel).toBe(colors.danger);
    } finally {
      await page.close();
    }
  });

  test("a flat disclosure row keeps a 44 px hit area on touch without growing", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true });
    try {
      await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui">${markup}</body></html>`);
      await settled(page);
      const sizes = await page.evaluate(() => {
        const toggle = document.querySelector("#flat .k2b-section__toggle")!;
        const hit = getComputedStyle(toggle, "::after");
        return { row: toggle.getBoundingClientRect().height, top: Number.parseFloat(hit.top), bottom: Number.parseFloat(hit.bottom) };
      });
      // Engines report sub-pixel layout (WebKit: 27.99999), so compare to the half pixel.
      expect(Math.abs(sizes.row - 28)).toBeLessThan(0.5);
      expect(sizes.row - sizes.top - sizes.bottom).toBeGreaterThanOrEqual(43.5);
    } finally {
      await page.close();
    }
  });
});
