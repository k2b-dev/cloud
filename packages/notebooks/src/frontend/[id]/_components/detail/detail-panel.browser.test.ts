import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../../../../ui/test/browser";
import type { DetailPanelHarness } from "./detail-panel.browser-harness";

// Each fixture types its browser window locally; other harnesses use the same property.
declare const window: { harness: DetailPanelHarness };

const activityPage = {
  data: ["note.edited", "comment.created", "note.restored", "note.edited", "note.created"].map((action, index) => ({
    id: `activity-${index}`,
    actor: { kind: "user", id: "00000000-0000-4000-8000-000000000002", displayName: "Jana Berger", avatarHash: "h1" },
    action,
    metadata: { commentId: "m11" },
    occurrenceCount: 1,
    lastOccurredAt: "2026-10-16T19:18:00.000Z",
  })),
  nextCursor: null,
};
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const ui = `${resolve(import.meta.dir, "../../../../../../ui")}/`;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "detail-panel.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    // The PDF dialog includes MapLibre's import.meta worker URLs.
    format: "esm",
    plugins: [
      {
        name: "solid-detail-panel-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the detail-panel harness.");
  const bundle = await build.outputs[0]!.text();
  // Use the shipped page-head order and cascade, including the responsive switch rule.
  const outputs = await Promise.all(
    [resolve(import.meta.dir, "../../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../../styles.css")].map(
      async (entry) => {
        const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
        if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}.`);
        return build.outputs[0]!.text();
      },
    ),
  );
  const css = ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/notebooks/overview/activity") return Response.json(activityPage);
      if (/^\/api\/accounts\/users\/[^/]+\/avatar$/.test(path))
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#247b92"/><circle cx="12" cy="9" r="4" fill="#fff"/></svg>',
          { headers: { "content-type": "image/svg+xml" } },
        );
      if (/^\/(fonts\/)?[a-zA-Z0-9._-]+\.(woff2|css)$/.test(path)) return new Response(Bun.file(resolve(ui, "dist", path.slice(1))));
      if (path.startsWith("/api/")) return new Response("Unexpected harness API", { status: 404 });
      if (path === "/harness.js") return new Response(bundle, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      return new Response(
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/plex.css"><link rel="stylesheet" href="/tabler.css"><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script type="module" src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const settle = async (page: Page) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
};
const open = async (width: number, delayActivity = false) => {
  const page = await browser.newPage({
    viewport: { width, height: width === 390 ? 844 : 900 },
    isMobile: width === 390,
    hasTouch: width === 390,
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = () => {};
  const request = new Promise<void>((resolve) => {
    requested = resolve;
  });
  try {
    await page.clock.setFixedTime(new Date("2026-10-16T19:30:00.000Z"));
    if (delayActivity)
      await page.route("**/api/notebooks/overview/activity?*", async (route) => {
        requested();
        await gate;
        if (!page.isClosed()) await route.continue();
      });
    await page.goto(`${server.url}?state=many`);
    await page.waitForFunction(() => Boolean(window.harness));
    if (delayActivity) await request;
    else await page.locator(".notebook-activity-skeleton").first().waitFor({ state: "detached" });
    await settle(page);
    return { page, release };
  } catch (error) {
    release();
    await page.close();
    throw error;
  }
};
const box = async (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    });
const closeTo = (actual: number, expected: number, tolerance = 1) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
const sameBox = (actual: Awaited<ReturnType<typeof box>>, expected: Awaited<ReturnType<typeof box>>) => {
  for (const key of ["x", "y", "width", "height"] as const) closeTo(actual[key], expected[key], 0.5);
};
const header = ".k2b-discussion__header";
const contents = '.k2b-detail-panel__section:has(h3:text-is("Inhalt"))';

for (const width of [1440, 390]) {
  test(`${width}: section and row text share one leading and trailing edge`, async () => {
    const { page } = await open(width);
    try {
      const edges = await page.evaluate(() => {
        const visible = (element: Element) => element.getBoundingClientRect().width > 0;
        const left = [
          ...document.querySelectorAll(
            ".k2b-detail-panel__section-header h3, .k2b-discussion__header h3, .k2b-discussion__entry > header > strong, .notebook-outline-row[data-depth='0'] .k2b-detail-panel__action-title, .notebook-activity .k2b-detail-panel__action-title, .k2b-detail-panel__section:has(.ti-paperclip) .k2b-detail-panel__action-title",
          ),
        ]
          .filter(visible)
          .map((element) => ({ label: element.textContent, x: element.getBoundingClientRect().left }));
        const right = [
          ...document.querySelectorAll(
            ".k2b-discussion__timestamp, .notebook-activity .notebook-time time, .k2b-detail-panel__section:has(.ti-paperclip) .k2b-detail-panel__action-trailing, .k2b-detail-panel__section-actions .k2b-button, .k2b-discussion__actions .k2b-button",
          ),
        ]
          .filter(visible)
          .map((element) => {
            // Compare label ink, excluding a control's padding and icon column.
            const range = document.createRange();
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let last: Text | null = null;
            // The last painted text: a tooltip's hidden content inside the element does not count.
            while (walker.nextNode())
              if (walker.currentNode.textContent?.trim() && (walker.currentNode.parentElement?.getClientRects().length ?? 0) > 0)
                last = walker.currentNode as Text;
            if (!last) throw new Error(`No label text: ${element.outerHTML}`);
            range.setStart(last, 0);
            range.setEnd(last, last.length - (last.textContent?.match(/\s*$/)?.[0].length ?? 0));
            return { label: element.textContent, x: range.getBoundingClientRect().right };
          });
        return { left, right };
      });
      expect(edges.left.length).toBeGreaterThan(14);
      expect(edges.right.length).toBeGreaterThan(8);
      for (const edge of edges.left) closeTo(edge.x, edges.left[0]!.x, 1);
      for (const edge of edges.right) closeTo(edge.x, edges.right[0]!.x, 2);
    } finally {
      await page.close();
    }
  }, 30_000);

  test(`${width}: activity, presence and disclosure keep earlier content in place`, async () => {
    const { page, release } = await open(width, true);
    try {
      expect(await page.locator(".notebook-activity-skeleton").count()).toBe(4);
      const tracked = [header, `${contents} .k2b-detail-panel__section-header`, ".k2b-discussion__item"];
      const before = await Promise.all(tracked.map((selector) => box(page, selector)));
      release();
      await page.locator(".notebook-activity-skeleton").first().waitFor({ state: "detached" });
      await settle(page);
      for (let index = 0; index < tracked.length; index++) sameBox(await box(page, tracked[index]!), before[index]!);
      const presenceTracked = [".k2b-detail-panel__supporting > p", ".k2b-detail-panel__body > :first-child", ".k2b-detail-panel__header"];
      const priorPresence = await Promise.all(presenceTracked.map((selector) => box(page, selector)));
      await page.evaluate(() => window.harness.presence(5));
      await settle(page);
      for (let index = 0; index < presenceTracked.length; index++) {
        const after = await box(page, presenceTracked[index]!);
        const before = priorPresence[index]!;
        if (index === 0) {
          closeTo(after.x, before.x, 0.5);
          closeTo(after.y, before.y, 0.5);
          closeTo(after.height, before.height, 0.5);
        } else sameBox(after, before);
      }
      const above = [".k2b-detail-panel__header", header, ".notebook-tasks"];
      const beforeCollapse = await Promise.all(above.map((selector) => box(page, selector)));
      // DOM click avoids Playwright scrolling the body to the disclosure.
      await page
        .locator(contents)
        .getByRole("button", { name: /^Inhalt/ })
        .evaluate((button) => {
          if (!(button instanceof HTMLButtonElement)) throw new Error("Expected a button");
          button.click();
        });
      await settle(page);
      for (let index = 0; index < above.length; index++) sameBox(await box(page, above[index]!), beforeCollapse[index]!);
      await page.getByRole("button", { name: /^Inhalt/ }).evaluate((button) => {
        if (!(button instanceof HTMLButtonElement)) throw new Error("Expected a button");
        button.click();
      });
      await settle(page);
      for (let index = 0; index < above.length; index++) sameBox(await box(page, above[index]!), beforeCollapse[index]!);
      const beforeFold = await box(page, header);
      await page.getByRole("button", { name: "9 ältere anzeigen" }).evaluate((button) => {
        if (!(button instanceof HTMLButtonElement)) throw new Error("Expected a button");
        button.click();
      });
      await settle(page);
      sameBox(await box(page, header), beforeFold);
      expect(await page.locator(".k2b-discussion__item").count()).toBe(12);
    } finally {
      release();
      await page.close();
    }
  }, 30_000);

  test(`${width}: Ansicht offers the available modes and offline actions explain recovery`, async () => {
    const { page } = await open(width);
    try {
      await page.getByRole("button", { name: "Ansicht", exact: true }).click();
      for (const name of ["Bearbeiten", "Lesen", "Buch", "Formatiert", "Markdown"])
        expect(await page.getByRole("menuitemradio", { name, exact: true }).isVisible()).toBe(true);
      expect(await page.getByRole("menuitemcheckbox", { name: "Volle Breite" }).isVisible()).toBe(width === 1440);
      if (width === 1440) {
        await page.getByRole("menuitemcheckbox", { name: "Volle Breite" }).click();
        expect(await page.getByRole("menuitemcheckbox", { name: "Volle Breite" }).isVisible()).toBe(true);
        await page.keyboard.press("Escape");
      } else await page.getByRole("button", { name: "Schließen", exact: true }).click();
      await page.evaluate(() => window.harness.offline(true));
      expect(await page.getByText("Keine Verbindung zum Server", { exact: true }).isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: "Erneut verbinden", exact: true }).isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: /^Mit KI bearbeiten/ }).isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: /^Kommentieren/ }).isDisabled()).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);
}
