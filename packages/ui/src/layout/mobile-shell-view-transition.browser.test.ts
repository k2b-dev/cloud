import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// What a view transition paints exists only in a real engine, so the built package runs in one: the pages of a shell,
// and transitions between them slowed to a minute, so the test can photograph one while it runs.
const packageRoot = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(packageRoot, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "mobile-shell-view-transition.fixture.ts");
const fixture = `
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { MobileShell, TabBar } from ${JSON.stringify(resolve(packageRoot, "dist/browser/index.js"))};

const pages = {
  "/start": { title: "Start", rows: ["Good morning"] },
  "/tasks": { title: "Tasks", rows: Array.from({ length: 12 }, (_, index) => "Task " + (index + 1)) },
  "/tasks/1": { title: "Task 1", back: { href: "/tasks", label: "Tasks" }, rows: ["Water the plants", "Due Friday"] },
};
const [page, setPage] = createSignal(pages[location.pathname]);
const items = [
  { id: "start", label: "Start", icon: "ti ti-home", href: "/start", current: location.pathname === "/start" },
  { id: "tasks", label: "Tasks", icon: "ti ti-checkbox", href: "/tasks", current: location.pathname !== "/start" },
];
render(
  () =>
    createComponent(MobileShell, {
      get header() {
        return createComponent(MobileShell.Header, { get title() { return page().title; }, get back() { return page().back; } });
      },
      get sidebar() {
        return createComponent(MobileShell.Sidebar, { label: "App", title: "Example Cloud", items });
      },
      get footer() {
        return createComponent(TabBar, { label: "App", items });
      },
      get children() {
        return page().rows.map((text) => {
          const row = document.createElement("a");
          row.href = "/tasks/1";
          row.style.cssText = "display:block;height:48px";
          row.textContent = text;
          // A part that navigates within its document, as @k2b/ssr/nav does.
          row.onclick = (event) => {
            if (!window.withinDocument) return;
            event.preventDefault();
            window.transition = document.startViewTransition(() => setPage(pages["/tasks/1"]));
          };
          return row;
        });
      },
    }),
  document.getElementById("root"),
);
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the MobileShell view transition fixture for the browser.");
const script = await build.outputs[0]!.text();

/**
 * A document of a host that turns on transitions between its documents, as the Cloud web does. The page's own
 * cross-fade runs for a minute, so the test photographs it at rest, and the browser first shows the document once its
 * body is parsed.
 */
const shellDocument = (body: string) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><link rel="expect" href="#parsed" blocking="render"><style>${css}</style><style>@view-transition{navigation:auto}::view-transition-group(root),::view-transition-old(root),::view-transition-new(root){animation-duration:60s}</style></head><body class="k2b-ui">${body}<span id="parsed"></span></body></html>`;
const clientDocument = shellDocument(`<div id="root"></div><script>${script}</script>`);
/** The pages a navigation leads to, as a server renders them: with their frame in the markup. */
const serverDocuments = new Map<string, string>();

let browser: Browser;
let decoder: Page;
beforeAll(async () => {
  browser = await launchBrowser();
  decoder = await browser.newPage();
  await decoder.route("https://shell.test/**", (route) => route.fulfill({ contentType: "text/html", body: clientDocument }));
  for (const path of ["/start", "/tasks/1"]) {
    await decoder.goto(`https://shell.test${path}`);
    serverDocuments.set(path, shellDocument(`<div id="root">${await decoder.locator("#root").innerHTML()}</div>`));
  }
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type Rect = { x: number; y: number; width: number; height: number };
type Frame = Record<string, Rect>;
type Transition = { ready: Promise<void>; finished: Promise<void>; skipTransition: () => void };
type Probe = Window & { transition?: Transition; shift: number; withinDocument?: boolean };

const frameParts = { header: ".k2b-mobile-shell__header", sidebar: ".k2b-mobile-shell__sidebar", footer: ".k2b-tab-bar" };

/** The shown parts of the frame and the content area, by their place on the screen. */
const layout = (page: Page) =>
  page.evaluate((parts) => {
    const rects: Frame = {};
    for (const [name, selector] of Object.entries({ ...parts, content: ".k2b-mobile-shell__main" })) {
      const element = document.querySelector(selector);
      if (!element?.getClientRects().length) continue;
      const { x, y, width, height } = element.getBoundingClientRect();
      rects[name] = { x, y, width, height };
    }
    return rects;
  }, frameParts);

/**
 * How many 4 × 4 pixel blocks of two screenshots differ visibly: in their average colour by more than a sixth of the
 * range. A transition's snapshot rasterizes text a little differently from the page, which nobody sees and which
 * changes blocks by up to a tenth; a frame that fades, moves, or shows another title changes them far more.
 */
const visiblyDifferentBlocks = (a: Buffer, b: Buffer) =>
  decoder.evaluate(
    async ([a, b]) => {
      const pixels = async (data: string) => {
        const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
        const context = new OffscreenCanvas(image.width, image.height).getContext("2d")!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height);
      };
      const [first, second] = [await pixels(a), await pixels(b)];
      const { width, height } = first;
      let blocks = 0;
      for (let top = 0; top < height; top += 4)
        for (let left = 0; left < width; left += 4) {
          const sums = [0, 0, 0];
          let count = 0;
          for (let y = top; y < Math.min(top + 4, height); y++)
            for (let x = left; x < Math.min(left + 4, width); x++, count++)
              for (const channel of [0, 1, 2]) {
                const index = (y * width + x) * 4 + channel;
                sums[channel]! += first.data[index]! - second.data[index]!;
              }
          if (sums.some((sum) => Math.abs(sum) / count > 42)) blocks++;
        }
      return blocks;
    },
    [a.toString("base64"), b.toString("base64")] as const,
  );

const open = async (width: number): Promise<Page> => {
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 768, hasTouch: true });
  const page = await context.newPage();
  // Every document counts its layout shifts and keeps the transition it shows itself with.
  await page.addInitScript(() => {
    const probe = window as unknown as Probe;
    probe.shift = 0;
    new PerformanceObserver((list) => {
      // As in Cumulative Layout Shift, a shift right after a tap is the answer to it.
      for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[])
        if (!entry.hadRecentInput) probe.shift += entry.value;
    }).observe({ type: "layout-shift", buffered: true });
    window.addEventListener("pagereveal", (event) => {
      const transition = (event as Event & { viewTransition: Transition | null }).viewTransition;
      if (transition) probe.transition = transition;
    });
  });
  await page.route("https://shell.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: serverDocuments.get(new URL(route.request().url()).pathname) ?? clientDocument }),
  );
  await page.goto("https://shell.test/tasks");
  await page.locator(".k2b-mobile-shell").waitFor();
  return page;
};

/** The transition's groups of the frame while it runs, as the browser computes them. */
const frameGroups = (page: Page, names: string[]) =>
  page.evaluate((names) => {
    const style = (part: string, name: string) =>
      getComputedStyle(document.documentElement, `::view-transition-${part}(k2b-mobile-shell-${name})`);
    const animated = document
      .getAnimations()
      .filter((animation) => animation.timeline === document.timeline && animation.playState === "running")
      .map((animation) => (animation.effect as KeyframeEffect | null)?.pseudoElement ?? "")
      .filter((pseudo) => pseudo.startsWith("::view-transition"));
    return {
      groups: Object.fromEntries(
        names.map((name) => {
          const group = style("group", name);
          const place = new DOMMatrixReadOnly(group.transform === "none" ? undefined : group.transform);
          return [
            name,
            {
              x: place.e,
              y: place.f,
              width: Number.parseFloat(group.width),
              height: Number.parseFloat(group.height),
              old: style("old", name).opacity,
              animated: animated.some((pseudo) => pseudo.endsWith(`(k2b-mobile-shell-${name})`)),
            },
          ];
        }),
      ),
      contentAnimated: animated.includes("::view-transition-new(root)"),
    };
  }, names);

/**
 * Playwright's WebKit leaves the new picture of a named element out of its screenshots while a transition runs, also
 * with the browser's own cross-fade, so there the frame's groups are checked by their computed styles alone.
 */
const photographsFrame = browserName !== "webkit";

const navigations = {
  "a row between documents": { link: "Task 1", url: "https://shell.test/tasks/1", title: "Task 1", withinDocument: false },
  "a row within the document": { link: "Task 1", url: "https://shell.test/tasks", title: "Task 1", withinDocument: true },
  "a tab between documents": { link: "Start", url: "https://shell.test/start", title: "Start", withinDocument: false },
};

describe("MobileShell in a view transition", () => {
  for (const width of [390, 1024])
    for (const [kind, navigation] of Object.entries(navigations))
      test(`${width} px, ${kind}: the frame shows the next page at once and stands still`, async () => {
        const page = await open(width);
        try {
          const { content, ...frameBefore } = await layout(page);
          const names = Object.keys(frameBefore).sort();
          expect(names).toEqual(width < 768 ? ["footer", "header"] : ["header", "sidebar"]);
          if (navigation.withinDocument) await page.evaluate(() => ((window as unknown as Probe).withinDocument = true));
          await page.getByRole("link", { name: navigation.link, exact: true }).tap();
          await page.waitForURL(navigation.url);
          await page.waitForFunction(() => (window as unknown as Probe).transition !== undefined);
          await page.evaluate(() => (window as unknown as Probe).transition!.ready);

          const clips: Frame = { ...frameBefore, content: content! };
          const shoot = async () =>
            Object.fromEntries(
              await Promise.all(Object.entries(clips).map(async ([name, clip]) => [name, await page.screenshot({ clip })] as const)),
            );
          const during = await shoot();
          const { groups, contentAnimated } = await frameGroups(page, names);
          await page.evaluate(() => {
            const { transition } = window as unknown as Probe;
            transition!.skipTransition();
            return transition!.finished;
          });
          const after = await shoot();
          const differences: Record<string, number> = {};
          for (const name of Object.keys(clips)) differences[name] = await visiblyDifferentBlocks(during[name]!, after[name]!);

          expect(await page.locator(".k2b-mobile-shell__title").innerText()).toBe(navigation.title);
          // The content was still on its way to the next page, while the frame already showed it in place: each part
          // of the frame is a group of its own at the part's place, without animation and without its old picture.
          expect(contentAnimated).toBe(true);
          expect(differences.content).toBeGreaterThan(0);
          const { content: contentAfter, ...frameAfter } = await layout(page);
          expect({
            groups,
            frameAfter,
            contentAfter,
            differences,
            shift: await page.evaluate(() => (window as unknown as Probe).shift),
          }).toEqual({
            groups: Object.fromEntries(Object.entries(frameBefore).map(([name, rect]) => [name, { ...rect, old: "0", animated: false }])),
            frameAfter: frameBefore,
            contentAfter: content!,
            differences: {
              ...Object.fromEntries(names.map((name) => [name, photographsFrame ? 0 : differences[name]])),
              content: differences.content!,
            },
            shift: 0,
          });
        } finally {
          await page.context().close();
        }
      }, 60_000);
});
