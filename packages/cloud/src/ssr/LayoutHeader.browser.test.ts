import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../../ui/test/browser";

// Which control a tap reaches depends on layout, paint order, and the island
// wrappers around each header action, which only a real engine shows.
const root = mkdtempSync(resolve(tmpdir(), "cloud-layout-header-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: LayoutHeader } = await import("./LayoutHeader");
const { ShellDataProvider } = await import("./shell-data");

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
    createComponent(ShellDataProvider, {
      data: {
        apps: [],
        legalLinks: [],
        profile: authenticated ? { name: "Demo User" } : undefined,
        theme: "light",
        searchLinks: {},
      },
      get children() {
        return createComponent(LayoutHeader, {
          authenticated,
          title: "Files",
          launchpad: true,
          breadcrumbs: authenticated ? undefined : [{ title: "Files", href: "/app/files" }],
          loginHref: authenticated ? undefined : "/auth/login?redirectTo=%2Fapp%2Ffiles",
        });
      },
    }),
  );

/** The header in the shell frame it gets from Layout, which decides its shape. */
const inCanvas = (authenticated: boolean) =>
  `<div class="cloud-app-canvas" data-layout-header${authenticated ? ' data-layout-authenticated="true"' : ""}>` +
  `<div class="layout-shell-content">${header(authenticated)}</div></div>`;

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
      if (!home) return { visible: [...visible], taken, homeReach: [] };
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
  expect(await takenPixels(inCanvas(true))).toEqual({
    visible: ["Open global search", "Open help", "Open apps"],
    taken: {},
    homeReach: [],
  });
  expect(await takenPixels(inCanvas(false))).toEqual({
    visible: ["Home", "Open help", "Open apps", "Language: English", "Appearance: Light. Switches to Dark.", "Sign in"],
    taken: {},
    homeReach: finger,
  });
}, 30_000);

test("the signed-out header is the same card with the same controls at every width; only the labels shorten (#2921)", async () => {
  const controls = ["Home", "Open help", "Open apps", "Language: English", "Appearance: Light. Switches to Dark.", "Sign in"];
  for (const [width, language, title, breadcrumbs] of [
    [360, "EN", false, false],
    [390, "EN", false, false],
    [900, "English", true, false],
    [1280, "English", false, true],
  ] as const) {
    // Phones draw their scrollbar over the page, as in the Layout, so the stable gutter takes no width there.
    const phone = width < 768;
    const page = await browser.newPage({ viewport: { width, height: 700 }, isMobile: phone, hasTouch: phone });
    try {
      await page.setContent(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
          `<body class="k2b-ui">${inCanvas(false)}</body></html>`,
      );
      await settled(page);
      const shape = await page.evaluate(() => {
        const header = document.querySelector<HTMLElement>(".layout-header")!;
        const box = header.getBoundingClientRect();
        const style = getComputedStyle(header);
        const shown = Array.from(header.querySelectorAll("a[href], button")).filter((element) => element.checkVisibility());
        const language = header.querySelector('[aria-haspopup="menu"]') as HTMLElement;
        return {
          box: { left: box.left, top: box.top, right: innerWidth - box.right, height: box.height },
          card: [style.borderTopLeftRadius, style.borderTopWidth, style.borderBottomWidth, style.boxShadow],
          controls: shown.map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim()),
          language: language.innerText.trim(),
          title: Boolean(header.querySelector(".layout-header-title")?.checkVisibility()),
          breadcrumbs: Boolean(header.querySelector("nav")?.checkVisibility()),
          // Every control sits inside the card: nothing is cut off or pushed past its edge.
          inside: shown.every((element) => {
            const rect = element.getBoundingClientRect();
            return rect.left >= box.left && rect.right <= box.right && rect.top >= box.top && rect.bottom <= box.bottom;
          }),
          signIn: (header.querySelector('a[href^="/auth/login"]') as HTMLAnchorElement).getAttribute("href"),
        };
      });
      expect(shape).toEqual({
        box: { left: 8, top: 8, right: 8, height: 46 },
        card: ["12px", "1px", "1px", "none"],
        controls,
        language,
        title,
        breadcrumbs,
        inside: true,
        signIn: "/auth/login?redirectTo=%2Fapp%2Ffiles",
      });
    } finally {
      await page.close();
    }
  }
}, 30_000);

test("toasts at the top of a phone start below the header instead of covering it", async () => {
  for (const authenticated of [true, false]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    try {
      // The rail reads the offset through @k2b/ui's narrow-viewport rule, like the probe below.
      await page.setContent(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
          `<body class="k2b-ui">${inCanvas(authenticated)}` +
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
