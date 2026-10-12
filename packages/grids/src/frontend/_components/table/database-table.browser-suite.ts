import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../../../../ui/test/browser";

const packageCache = resolve(import.meta.dir, "../../../../node_modules/.cache");
mkdirSync(packageCache, { recursive: true });
const root = mkdtempSync(join(packageCache, "grids-table-browser-"));
const { plugin } = createConfig({
  dev: false,
  verbose: false,
  rootDir: root,
  componentRoots: [resolve(import.meta.dir, "../../../../test/fixtures")],
});
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: WorkspaceFixture } = await import("./database-table.browser-fixture");
const ui = resolve(import.meta.dir, "../../../../../ui/dist");
const styleEntries = [
  resolve(import.meta.dir, "../../../styles/app.css"),
  resolve(import.meta.dir, "../../../../../cloud/src/styles/global.css"),
];
let css = "";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const builds = await Promise.all(styleEntries.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of builds) if (!build.success) throw new AggregateError(build.logs, "Could not compile the Grids stylesheets.");
  css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(builds.map((build) => build.outputs[0]!.text()))),
  ].join("\n");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/_ssr/")) return new Response(Bun.file(join(root, url.pathname)));
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(join(ui, url.pathname.slice(4))));
      return new Response(
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><link rel="stylesheet" href="/ui/plex.css"><style>${css}</style>` +
          '<style>solid-island{display:contents}</style></head><body class="k2b-ui" style="margin:0"><main style="display:flex;flex-direction:column;height:100dvh">' +
          renderToString(() => createComponent(WorkspaceFixture, {})) +
          "</main><script type=\"module\">document.querySelectorAll('solid-island').forEach(e=>import('/_ssr/'+e.dataset.id+'.js'))</script></body></html>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

describe("Grids table beside Detail", () => {
  for (const [width, height] of [
    [1366, 900],
    [1920, 1080],
  ] as const) {
    test(`${width}×${height}: rounded viewport, one inset, and intact dates and amounts`, async () => {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
      try {
        await page.goto(`${server.url}app/grids/base`);
        await page.locator('[data-scrollbar-enhanced="true"]').waitFor();
        await page.evaluate(() => document.fonts.ready);
        const shape = await page.locator(".k2b-table-wrap.k2b-detail-trail").evaluate((viewport) => {
          const token = (name: string) => {
            const probe = document.createElement("div");
            probe.style.width = `var(${name})`;
            viewport.append(probe);
            const pixels = probe.getBoundingClientRect().width;
            probe.remove();
            return pixels;
          };
          const style = getComputedStyle(viewport);
          return {
            inset: token("--k2b-workspace-detail-inset"),
            radius: token("--k2b-radius-surface"),
            // The viewport sits inside the table's Paper frame; the frame is the surface's outer edge.
            right: (viewport.closest(".k2b-paper") ?? viewport).getBoundingClientRect().right,
            panelLeft: document.querySelector(".k2b-app-workspace__detail")!.getBoundingClientRect().left,
            radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].map(
              Number.parseFloat,
            ),
            scroll: viewport.scrollWidth,
            client: viewport.clientWidth,
          };
        });
        expect(shape.scroll).toBeGreaterThan(shape.client);
        expect(shape.right).toBeCloseTo(shape.panelLeft - shape.inset, 1);
        for (const radius of shape.radii) expect(radius).toBeCloseTo(shape.radius, 1);
        for (const [column, expected] of [
          [4, "12400,00 EUR"],
          [5, "2026-11-14"],
        ] as const) {
          const value = await page.locator(`tbody tr:first-child td:nth-child(${column})`).evaluate((cell) => {
            const content = cell.firstElementChild;
            if (!(content instanceof HTMLElement)) throw new Error("Expected the cell content wrapper.");
            const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
            const text = walker.nextNode();
            if (!text) throw new Error("Expected a value text node.");
            const range = document.createRange();
            range.selectNodeContents(text);
            const bounds = range.getBoundingClientRect();
            const box = content.getBoundingClientRect();
            return {
              text: content.textContent,
              lines: range.getClientRects().length,
              scroll: content.scrollWidth,
              client: content.clientWidth,
              left: bounds.left,
              right: bounds.right,
              contentLeft: box.left,
              contentRight: box.right,
            };
          });
          expect(value.text).toBe(expected);
          expect(value.lines).toBe(1);
          expect(value.scroll).toBeLessThanOrEqual(value.client);
          expect(value.left).toBeGreaterThanOrEqual(value.contentLeft - 0.5);
          expect(value.right).toBeLessThanOrEqual(value.contentRight + 0.5);
        }
        const notes = await page.locator("tbody tr:first-child td:nth-child(11)").evaluate((cell) => {
          const content = cell.firstElementChild!;
          const range = document.createRange();
          range.selectNodeContents(content);
          return { nowrap: cell.hasAttribute("data-nowrap"), lines: range.getClientRects().length };
        });
        expect(notes.nowrap).toBe(false);
        expect(notes.lines).toBeGreaterThan(1);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});
