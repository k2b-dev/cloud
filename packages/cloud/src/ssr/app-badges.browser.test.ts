import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../../ui/test/browser";
import type { RailApp } from "./rail-navigation";

// Whether a badge moves anything or is clipped by the rail's scroller depends
// on the compiled stylesheet and real layout, which only an engine shows.
const root = mkdtempSync(resolve(tmpdir(), "cloud-app-badges-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: RailApps } = await import("./RailApps.island");
const { AppLaunchpadPanel } = await import("./AppLaunchpadPanel");

const apps: RailApp[] = ["Chat", "Files", "Mail", "Notebooks"].map((label) => ({
  id: label.toLowerCase(),
  label,
  href: `/app/${label.toLowerCase()}`,
  match: `/app/${label.toLowerCase()}`,
  iconClass: "ti ti-apps",
  defaultVisible: true,
  badge: `/api/${label.toLowerCase()}/badge`,
}));

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

const inLocale = (render: () => JSX.Element) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return render();
      },
    }),
  );

const rail = () =>
  `<aside class="layout-rail flex w-10 shrink-0 flex-col" style="height:20rem"><nav class="flex min-h-0 flex-1 flex-col items-center gap-1">${inLocale(
    () => createComponent(RailApps, { apps, settings: { revision: 0, visibility: {}, shortcuts: [] }, currentPath: "/app/chat" }),
  )}</nav></aside>`;
const grid = (surface: "panel" | "sheet") =>
  inLocale(() => createComponent(AppLaunchpadPanel, { apps, legalLinks: [], close: () => {}, surface }));

/**
 * Lays out the markup, records every icon, glyph and label, adds a badge to
 * every icon the way `AppBadge` renders it, and records them again. Returns
 * what moved and every badge pixel an overflow-clipping ancestor cuts off.
 */
const badgeEffect = async (markup: string, iconSelector: string, viewport: { width: number; height: number }) => {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui">${markup}</body></html>`);
    return await page.evaluate(
      ({ iconSelector }) => {
        const icons = Array.from(document.querySelectorAll<HTMLElement>(iconSelector));
        const boxes = () =>
          Array.from(document.querySelectorAll("a, a *")).map((element) => {
            const box = element.getBoundingClientRect();
            return box.width || box.height ? `${element.className} ${box.x},${box.y},${box.width},${box.height}` : "";
          });
        const before = boxes();
        const clipped: string[] = [];
        for (const text of ["1", "99+"]) {
          for (const icon of icons) {
            icon.querySelector(".cloud-app-badge")?.remove();
            icon.insertAdjacentHTML("beforeend", `<span class="cloud-app-badge" aria-hidden="true">${text}</span>`);
          }
          for (const badge of Array.from(document.querySelectorAll<HTMLElement>(".cloud-app-badge"))) {
            const box = badge.getBoundingClientRect();
            if (box.width < 12 || box.height < 12) clipped.push(`${text}: badge is ${box.width}x${box.height}`);
            for (let parent = badge.parentElement; parent; parent = parent.parentElement) {
              const style = getComputedStyle(parent);
              if (style.overflowX === "visible" && style.overflowY === "visible") continue;
              const frame = parent.getBoundingClientRect();
              if (box.left < frame.left || box.right > frame.right || box.top < frame.top || box.bottom > frame.bottom) {
                clipped.push(`${text}: ${parent.className}`);
              }
            }
          }
        }
        const after = boxes().filter((entry) => !entry.startsWith("cloud-app-badge "));
        return { icons: icons.length, moved: after.filter((entry, index) => entry !== before[index]), clipped };
      },
      { iconSelector },
    );
  } finally {
    await page.close();
  }
};

test("a badge in the rail moves no icon and is not cut off by the rail's scroller", async () => {
  expect(await badgeEffect(rail(), ".rail-item", { width: 1280, height: 800 })).toEqual({ icons: 4, moved: [], clipped: [] });
}, 30_000);

test("a badge in the app grid moves no icon or label, on desktop and on a phone", async () => {
  expect(await badgeEffect(grid("panel"), ".app-icon", { width: 1280, height: 800 })).toEqual({ icons: 4, moved: [], clipped: [] });
  expect(await badgeEffect(grid("sheet"), ".app-icon", { width: 390, height: 664 })).toEqual({ icons: 4, moved: [], clipped: [] });
}, 30_000);
