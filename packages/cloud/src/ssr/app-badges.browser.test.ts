import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Request } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, pageErrors } from "../../../ui/test/browser";
import { APPROVAL_COUNTS_PATH } from "../contracts/approval-paths";
import type { RailApp } from "./rail-navigation";

// Whether a badge moves anything or is clipped by the rail's scroller depends
// on the compiled stylesheet and real layout, which only an engine shows.
const root = mkdtempSync(resolve(tmpdir(), "cloud-app-badges-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: RailApps } = await import("./RailApps");
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
let badgeRuntime: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  const entry = resolve(import.meta.dir, "app-badges.runtime-fixture.ts");
  const runtime = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `
import { createEffect } from "solid-js";
import { watchAppBadges, appBadgeCount, approvalCount } from "./app-badges";
import { refreshAppBadges } from "../browser/app-badges";
const endpoint = "/api/chat/badge";
const originalFetch = window.fetch;
window.badgeResponses = [];
window.fetch = async (...args) => {
  const response = await originalFetch(...args);
  window.badgeResponses.push(response);
  return response;
};
createEffect(() => {
  document.querySelector("output").textContent = JSON.stringify([appBadgeCount({ endpoint }), approvalCount()]);
});
document.querySelector("#refresh").onclick = refreshAppBadges;
document.querySelector("#stop").onclick = watchAppBadges([endpoint, endpoint]);
`,
    },
    target: "browser",
    conditions: ["browser"],
    format: "iife",
  });
  if (!runtime.success) throw new AggregateError(runtime.logs, "Could not bundle the badge lifecycle fixture.");
  badgeRuntime = await runtime.outputs[0]!.text();
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
  `<aside class="layout-rail flex w-14 shrink-0 flex-col" style="height:20rem"><nav class="flex min-h-0 flex-1 flex-col items-center gap-1">${inLocale(
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
            if (badge.parentElement!.matches(".rail-item")) {
              const item = badge.parentElement!.getBoundingClientRect();
              const rail = badge.closest(".layout-rail")!.getBoundingClientRect();
              if (rail.width !== 56 || item.width !== 44 || item.height !== 44 || item.left < rail.left || item.right > rail.right)
                clipped.push(`${text}: rail target is outside the 56 px rail or is not 44x44`);
              if (box.left < item.left || box.right > item.right || box.top < item.top || box.bottom > item.bottom)
                clipped.push(`${text}: badge is outside its item`);
            }
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
  for (const [width, height] of [
    [768, 1024],
    [834, 1194],
    [1194, 834],
    [1440, 900],
    [1920, 1080],
  ] as const)
    expect(await badgeEffect(rail(), ".rail-item", { width, height })).toEqual({ icons: 4, moved: [], clipped: [] });
}, 30_000);

test("a badge in the app grid moves no icon or label, on desktop and on a phone", async () => {
  expect(await badgeEffect(grid("panel"), ".app-icon", { width: 1280, height: 800 })).toEqual({ icons: 4, moved: [], clipped: [] });
  expect(await badgeEffect(grid("sheet"), ".app-icon", { width: 390, height: 664 })).toEqual({ icons: 4, moved: [], clipped: [] });
}, 30_000);

declare global {
  interface Window {
    badgeResponses: Response[];
  }
}

test.each(["finite", "streaming"] as const)(
  "failed %s badge bodies release the browser request and allow a refresh",
  async (body) => {
    const paths = ["/api/chat/badge", APPROVAL_COUNTS_PATH];
    let failing = false;
    const disconnected = new Set<string>();
    const server = createServer((request, response) => {
      const path = request.url ?? "/";
      if (paths.includes(path)) {
        response.setHeader("cache-control", "no-store");
        if (!failing) {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(path === APPROVAL_COUNTS_PATH ? { total: 2, apps: { chat: 2 } } : { count: 3 }));
        } else if (body === "finite") {
          response.writeHead(403, { "content-type": "text/plain", "content-length": "208" });
          response.end("x".repeat(208));
        } else {
          // Deliberately never end: cleanup must disconnect without buffering an error text or waiting for EOF.
          response.on("close", () => disconnected.add(path));
          response.writeHead(503, { "content-type": "text/plain" });
          response.write("unavailable");
        }
      } else if (path === "/runtime.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(badgeRuntime);
      } else {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          '<!doctype html><output></output><button id="refresh">Refresh</button><button id="stop">Stop</button><script src="/runtime.js"></script>',
        );
      }
    });
    const page = await browser.newPage();
    const errors = pageErrors(page);
    const requests: Request[] = [];
    const ended = new Set<Request>();
    page.on("request", (request) => {
      if (paths.includes(new URL(request.url()).pathname)) requests.push(request);
    });
    page.on("requestfinished", (request) => ended.add(request));
    page.on("requestfailed", (request) => ended.add(request));
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing loopback test address");
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.waitForFunction(() => document.querySelector("output")?.textContent === "[3,2]");
      failing = true;
      await page.getByText("Refresh", { exact: true }).click();
      await page.waitForFunction(() => document.querySelector("output")?.textContent === "[0,0]");
      // Keep the original Responses alive without reading them: GC must not be what releases the request.
      expect(
        await page.evaluate(() => window.badgeResponses.filter((response) => response.status !== 200).map((response) => response.bodyUsed)),
      ).toEqual([true, true]);
      const failedRequests = requests.slice(2);
      expect(failedRequests).toHaveLength(2);
      const deadline = performance.now() + 5_000;
      while (
        (!failedRequests.every((request) => ended.has(request)) || (body === "streaming" && disconnected.size !== 2)) &&
        performance.now() < deadline
      )
        await Bun.sleep(10);
      // Playwright reports CDP loadingFinished/loadingFailed in Chromium and the corresponding WebKit terminal event.
      expect(failedRequests.every((request) => ended.has(request))).toBe(true);
      if (body === "streaming") expect([...disconnected].sort()).toEqual([...paths].sort());

      failing = false;
      await page.getByText("Refresh", { exact: true }).click();
      await page.waitForFunction(() => document.querySelector("output")?.textContent === "[3,2]");
      expect(requests).toHaveLength(6);
      await page.getByText("Stop", { exact: true }).click();
      await page.getByText("Refresh", { exact: true }).click();
      expect(requests).toHaveLength(6);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  },
  20_000,
);
