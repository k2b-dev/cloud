import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../../ui/test/browser";

// Which control a tap reaches depends on layout, paint order, and the island
// wrappers around each header action, which only a real engine shows.
const root = mkdtempSync(resolve(tmpdir(), "cloud-layout-header-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: LayoutHeader } = await import("./LayoutHeader");

let browser: Browser;
let css: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const header = (authenticated: boolean) =>
  renderToString(() =>
    createComponent(LayoutHeader, {
      authenticated,
      appLabel: "Files",
      breadcrumbs: [{ title: "Files", href: "/app/files" }],
      homeLabel: "Home",
      launchpadApps: [],
      legalLinks: [],
      openAppsLabel: "Open apps",
      profileName: "Demo User",
      searchHelpApps: [],
      signInLabel: "Sign in",
      theme: "light",
    }),
  );

/**
 * Taps every pixel of every visible header control with the touch hit areas
 * switched off, then again with them on, and lists the pixels a hit area took
 * from another control. Every pixel counts, the outermost ring included: a
 * browser can resolve a tap on the last pixel before an edge to the box behind
 * it, so a hit area that merely touches a control takes a strip from it. Also
 * probes 21 px from the centre of the Home link in each direction, a reach only
 * a 44 px touch area has.
 */
const takenPixels = async (markup: string) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  try {
    await page.setContent(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>` +
        `<style id="without-hit-areas">.k2b-ui .k2b-button::after { content: none !important; }</style></head>` +
        `<body class="k2b-ui">${markup}</body></html>`,
    );
    return await page.evaluate(() => {
      const controls = "button, a[href]";
      const name = (element: Element | null) =>
        element ? (element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "") : "nothing";
      const tap = (x: number, y: number) => document.elementFromPoint(x, y)?.closest(controls) ?? null;
      const owned: [Element, number, number][] = [];
      for (const control of Array.from(document.querySelectorAll(controls))) {
        const box = control.getBoundingClientRect();
        for (let x = Math.floor(box.left); x < box.right; x += 1) {
          for (let y = Math.floor(box.top); y < box.bottom; y += 1) {
            if (tap(x + 0.5, y + 0.5) === control) owned.push([control, x + 0.5, y + 0.5]);
          }
        }
      }
      const visible = new Set(owned.map(([control]) => name(control)));
      document.getElementById("without-hit-areas")?.remove();
      const taken: Record<string, number> = {};
      for (const [control, x, y] of owned) {
        const hit = tap(x, y);
        if (hit === control) continue;
        const key = `${name(control)} -> ${name(hit)}`;
        taken[key] = (taken[key] ?? 0) + 1;
      }
      const home = document.querySelector<HTMLAnchorElement>('a[href="/"]')!;
      const box = home.getBoundingClientRect();
      const reaches = (x: number, y: number) => tap(x, y) === home;
      const midX = box.left + box.width / 2;
      const midY = box.top + box.height / 2;
      const homeReach = [reaches(midX - 21, midY), reaches(midX + 21, midY), reaches(midX, midY - 21), reaches(midX, midY + 21)];
      return { visible: [...visible], taken, homeReach };
    });
  } finally {
    await page.close();
  }
};

test("phone header actions keep every visible pixel and Home is finger-sized when touch hit areas are on", async () => {
  const finger = [true, true, true, true];
  expect(await takenPixels(header(true))).toEqual({
    visible: ["Home", "Open help", "Open global search", "Open apps"],
    taken: {},
    homeReach: finger,
  });
  expect(await takenPixels(header(false))).toEqual({
    visible: ["Home", "Open help", "Open apps", "Appearance and language", "Sign in"],
    taken: {},
    homeReach: finger,
  });
}, 30_000);

test("toasts at the top of a phone start below the header instead of covering it", async () => {
  for (const authenticated of [true, false]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    try {
      // The rail reads the offset through @k2b/ui's narrow-viewport rule, like the probe below.
      await page.setContent(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
          `<body class="k2b-ui"><div class="cloud-app-canvas"><div class="layout-shell-content">${header(authenticated)}</div></div>` +
          `<div id="probe" style="position:fixed;top:var(--k2b-toast-offset-top,0px)"></div></body></html>`,
      );
      const edges = await page.evaluate(() => [
        Math.round(document.querySelector(".layout-header")!.getBoundingClientRect().bottom),
        Math.round(document.getElementById("probe")!.getBoundingClientRect().top),
      ]);
      expect(edges[1]).toBe(edges[0]!);
    } finally {
      await page.close();
    }
  }
});
