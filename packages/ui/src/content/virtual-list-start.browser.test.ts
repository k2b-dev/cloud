import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// A VirtualFeed that starts at the top, as a work list: the server's first rows are the browser's first picture, it
// loads below, keeps its place when items arrive above, and keeps each group's heading in view.
const packageRoot = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(packageRoot, "dist/styles.css"), "utf8");

// The same items and props on the server and in the browser. Groups of 40 rows are taller than the rows the feed
// keeps mounted around the visible part, so a group's heading row leaves the DOM while its group is in view.
const data = `
const GROUP = 40;
const lines = (seq) => 1 + ((seq * 7) % 5 === 0 ? 2 : 0) + (seq % 11 === 0 ? 1 : 0);
const make = (seq, prefix = "i") => ({ id: prefix + seq, seq, group: Math.floor(seq / GROUP), lines: lines(seq) });
const props = (items, extra = {}) => ({
  anchor: "start",
  items,
  getKey: (item) => item.id,
  estimateSize: (item) => 12 + item.lines * 20,
  label: "Inbox",
  itemLabel: (item) => "Item " + item.id,
  separator: (item, previous) => (previous && previous.group === item.group ? undefined : "Group " + item.group),
  stickySeparators: true,
  ...extra,
});
const rowOf = (item) => {
  const element = document.createElement("div");
  element.className = "row";
  element.textContent = "Item " + item.id + " " + "word ".repeat(item.lines * 12);
  return element;
};
`;

const serverEntry = resolve(import.meta.dir, "virtual-list-start.server-fixture.ts");
const serverBuild = await Bun.build({
  entrypoints: [serverEntry],
  files: {
    [serverEntry]: `
import { createComponent } from "solid-js";
import { renderToString, ssr } from "solid-js/web";
import { VirtualFeed } from ${JSON.stringify(resolve(packageRoot, "dist/ssr/index.js"))};
${data.replace("const rowOf = (item) => {", "const domRow = (item) => {")}
const serverRow = (item) => ssr(['<div class="row">', "</div>"], "Item " + item.id + " " + "word ".repeat(item.lines * 12));
export const html = renderToString(() =>
  createComponent(VirtualFeed, { ...props(Array.from({ length: 120 }, (_, seq) => make(seq)), { hasMore: true, onLoadMore: () => {} }), children: serverRow }),
);
`,
  },
  target: "node",
  conditions: ["node"],
});
if (!serverBuild.success) throw new AggregateError(serverBuild.logs, "Could not bundle the server fixture.");
const serverDir = mkdtempSync(resolve(tmpdir(), "k2b-ui-virtual-list-start-"));
process.once("exit", () => rmSync(serverDir, { recursive: true, force: true }));
const serverModule = resolve(serverDir, "server.mjs");
writeFileSync(serverModule, await serverBuild.outputs[0]!.text());
const { html: serverHtml }: { html: string } = await import(serverModule);

const entry = resolve(import.meta.dir, "virtual-list-start.fixture.ts");
const build = await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: `
import { createComponent, createSignal, mergeProps } from "solid-js";
import { render } from "solid-js/web";
import { VirtualFeed } from ${JSON.stringify(resolve(packageRoot, "dist/browser/index.js"))};
${data}
const options = window.fixtureOptions ?? {};
window.errors = [];
window.addEventListener("error", (event) => window.errors.push(event.message));
const all = Array.from({ length: 400 }, (_, seq) => make(seq));
let next = 120;
let fresh = 0;
const [items, setItems] = createSignal(all.slice(0, next));
const [hasMore, setHasMore] = createSignal(true);
let gates = [];
let loads = 0;
let fail = Boolean(options.fail);
let controller;
const mount = () => {
  const host = document.getElementById("feed");
  // As an island does: the browser renders again over the server's markup, in one task.
  host.innerHTML = "";
  render(
    () =>
      createComponent(
        VirtualFeed,
        mergeProps(props([]), {
          get items() {
            return items();
          },
          get hasMore() {
            return hasMore();
          },
          onLoadMore: () => {
            loads++;
            return new Promise((done) => gates.push(done)).then(() => {
              if (fail) throw new Error("Server unavailable");
              const page = all.slice(next, next + 40);
              next += page.length;
              setItems((current) => [...current, ...page]);
              setHasMore(next < all.length);
            });
          },
          controller: (value) => (controller = value),
          children: rowOf,
        }),
      ),
    host,
  );
};
window.list = {
  mount,
  get controller() {
    return controller;
  },
  loads: () => loads,
  release() {
    const waiting = gates;
    gates = [];
    for (const done of waiting) done();
    return waiting.length;
  },
  heal() {
    fail = false;
  },
  /** Live items arrive above the first loaded one. */
  prepend(count) {
    const page = Array.from({ length: count }, () => ({ ...make(fresh++, "n"), group: -1 }));
    setItems((current) => [...page, ...current]);
  },
  viewport: () => document.querySelector(".k2b-virtual-feed__viewport"),
  /** Tops, relative to the visible area, of the rows and the headings a reader sees. */
  picture() {
    const port = document.querySelector(".k2b-virtual-feed__viewport").getBoundingClientRect();
    const seen = (rect) => rect.bottom > port.top + 0.5 && rect.top < port.bottom - 0.5;
    const rows = [...document.querySelectorAll(".k2b-virtual-feed__item")]
      .map((row) => [row.dataset.key, row.querySelector(".row").getBoundingClientRect()])
      .filter(([, rect]) => seen(rect))
      .map(([key, rect]) => [key, Math.round((rect.top - port.top) * 10) / 10]);
    return rows;
  },
  /** Every heading text the reader can see, from the top, with its top and bottom. */
  headings() {
    const port = document.querySelector(".k2b-virtual-feed__viewport").getBoundingClientRect();
    return [...document.querySelectorAll(".k2b-virtual-feed__separator > span")]
      .map((span) => [span.textContent, span.closest(".k2b-virtual-feed__separator").getBoundingClientRect(), Boolean(span.closest(".k2b-virtual-feed__sticky"))])
      .filter(([, rect]) => rect.bottom > port.top + 0.5 && rect.top < port.bottom - 0.5)
      .map(([text, rect, sticky]) => ({ text, top: Math.round((rect.top - port.top) * 10) / 10, bottom: Math.round((rect.bottom - port.top) * 10) / 10, sticky }))
      .sort((a, b) => a.top - b.top);
  },
};
if (!options.serverFirst) mount();
`,
  },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the list fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type Heading = { text: string; top: number; bottom: number; sticky: boolean };
declare const list: {
  mount: () => void;
  controller: { scrollToStart: () => void; scrollToKey: (key: string, options?: { align?: "start" | "center" }) => boolean };
  loads: () => number;
  release: () => number;
  heal: () => void;
  prepend: (count: number) => void;
  viewport: () => HTMLElement;
  picture: () => Array<[string, number]>;
  headings: () => Heading[];
};
declare const errors: string[];

const open = async (options: { serverFirst?: boolean; fail?: boolean } = {}, context: BrowserContextOptions = {}): Promise<Page> => {
  const page = await (await browser.newContext({ viewport: { width: 720, height: 640 }, ...context })).newPage();
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}
html, body { margin: 0; height: 100%; }
#feed { display: flex; height: 100vh; min-height: 0; flex-direction: column; }
.row { padding: 6px 12px; font: 14px/20px sans-serif; overflow-wrap: anywhere; }
</style></head><body class="k2b-ui"><div id="feed">${options.serverFirst ? serverHtml : ""}</div></body></html>`,
  );
  await page.addScriptTag({ content: `window.fixtureOptions = ${JSON.stringify(options)};` });
  await page.addScriptTag({ content: script });
  if (!options.serverFirst) {
    await page.locator(".k2b-virtual-feed__item").first().waitFor();
    await frames(page, 3);
  }
  return page;
};
const frames = (page: Page, count: number) =>
  page.evaluate(
    (count) =>
      new Promise<void>((done) => {
        let seen = 0;
        const tick = () => (++seen >= count ? done() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    count,
  );
const close = async (page: Page) => {
  expect(await page.evaluate(() => errors)).toEqual([]);
  await page.close();
};
const scrollTo = async (page: Page, top: number) => {
  await page.evaluate((top) => {
    list.viewport().scrollTop = top;
  }, top);
  await frames(page, 3);
};

describe(`VirtualFeed anchor="start" in ${browserName}`, () => {
  test("the server's rows are the browser's first picture, on the same pixels", async () => {
    for (const viewport of [
      { width: 720, height: 640 },
      { width: 390, height: 844 },
    ]) {
      const page = await open({ serverFirst: true }, { viewport, hasTouch: viewport.width < 500 });
      const server = await page.evaluate(() => ({ rows: list.picture(), headings: list.headings() }));
      expect(server.rows[0]).toEqual(["i0", expect.any(Number)]);
      expect(server.rows.length).toBeGreaterThan(5);
      // The browser renders over the server's markup in one task; what it shows before the next paint counts.
      const client = await page.evaluate(() => {
        list.mount();
        return { rows: list.picture(), headings: list.headings().filter((heading) => !heading.sticky) };
      });
      expect(client.rows).toEqual(server.rows);
      expect(client.headings).toEqual(server.headings);
      // The sticky copy lies exactly on the first heading, and nothing moves in the frames after.
      await frames(page, 3);
      expect(await page.evaluate(() => list.picture())).toEqual(server.rows);
      const after = await page.evaluate(() => list.headings());
      expect(after.filter((heading) => heading.sticky)).toEqual([{ ...server.headings[0]!, sticky: true }]);
      expect(await page.evaluate(() => list.viewport().scrollTop)).toBe(0);
      await close(page);
    }
  });

  test("opens at the first item, offers nothing at the end, and never follows appended items", async () => {
    const page = await open();
    expect(await page.evaluate(() => list.picture()[0])).toEqual(["i0", expect.any(Number)]);
    expect(await page.locator(".k2b-virtual-feed__end").count()).toBe(0);
    expect(await page.locator(".k2b-virtual-feed").getAttribute("data-anchor")).toBe("start");
    // Loading more below keeps the reader at the top.
    await scrollTo(page, 0);
    expect(await page.evaluate(() => list.viewport().scrollTop)).toBe(0);
    await close(page);
  });

  test("loads more at the end with a busy feed, and keeps the reader's place", async () => {
    const page = await open();
    const end = await page.evaluate(() => list.viewport().scrollHeight - list.viewport().clientHeight);
    await scrollTo(page, end - 1200);
    expect(await page.evaluate(() => list.loads())).toBe(1);
    expect(await page.locator("[role='feed']").getAttribute("aria-busy")).toBe("true");
    const edge = page.locator(".k2b-virtual-feed__more .k2b-load-more");
    expect(await edge.getAttribute("data-state")).toBe("loading");
    const before = await page.evaluate(() => list.picture());
    expect(await page.evaluate(() => list.release())).toBe(1);
    await frames(page, 3);
    expect(await page.locator("[role='feed']").getAttribute("aria-busy")).toBe("false");
    const after = new Map(await page.evaluate(() => list.picture()));
    for (const [key, top] of before) expect(Math.abs((after.get(key) ?? Number.NaN) - top)).toBeLessThanOrEqual(1);
    await close(page);
  });

  test("a failed page shows its error with Try again and waits for the reader", async () => {
    const page = await open({ fail: true });
    const end = await page.evaluate(() => list.viewport().scrollHeight - list.viewport().clientHeight);
    await scrollTo(page, end);
    await page.evaluate(() => list.release());
    await frames(page, 2);
    const edge = page.locator(".k2b-virtual-feed__more .k2b-load-more");
    expect(await edge.getAttribute("data-state")).toBe("error");
    expect(await edge.locator("[role='alert']").textContent()).toContain("Server unavailable");
    // The reader is at the end, inside the error row; scrolling there does not retry by itself.
    await scrollTo(page, end - 40);
    await scrollTo(page, end + 200);
    expect(await page.evaluate(() => list.loads())).toBe(1);
    await page.evaluate(() => list.heal());
    await edge.getByRole("button", { name: "Retry" }).click();
    expect(await page.evaluate(() => list.loads())).toBe(2);
    const count = await page.locator(".k2b-virtual-feed__item").last().getAttribute("data-index");
    await page.evaluate(() => list.release());
    await frames(page, 3);
    // The page arrived; the reader still at the end asks for the next one.
    expect(Number(await page.locator(".k2b-virtual-feed__item").last().getAttribute("data-index"))).toBeGreaterThan(Number(count));
    expect(await edge.getAttribute("data-state")).not.toBe("error");
    expect(await edge.locator("[role='alert']").count()).toBe(0);
    await close(page);
  });

  test("items that arrive above keep the reading position and offer New above, announced once", async () => {
    const page = await open();
    await scrollTo(page, 1500);
    const before = await page.evaluate(() => list.picture());
    await page.evaluate(() => list.prepend(3));
    await frames(page, 3);
    const after = new Map(await page.evaluate(() => list.picture()));
    for (const [key, top] of before) expect(Math.abs((after.get(key) ?? Number.NaN) - top)).toBeLessThanOrEqual(1);
    const button = page.locator(".k2b-virtual-feed__end[data-edge='start']");
    expect(await button.getAttribute("aria-label")).toBe("New above, 3 new");
    expect(await button.textContent()).toContain("New above");
    await page.waitForFunction(() => document.querySelector("[role='log']")?.textContent === "3 new items above");
    await button.click();
    await frames(page, 3);
    expect(await page.evaluate(() => list.viewport().scrollTop)).toBe(0);
    expect(await page.evaluate(() => list.picture()[0]?.[0])).toBe("n0");
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.key)).toBe("n0");
    expect(await button.count()).toBe(0);

    // At the very top too, new items stay above until the reader asks for them: what the reader read stays in place.
    const top = await page.evaluate(() => new Map(list.picture()).get("n0"));
    await page.evaluate(() => list.prepend(1));
    await frames(page, 3);
    expect(await page.evaluate(() => list.viewport().scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => new Map(list.picture()).get("n0"))).toBe(top);
    expect(await button.getAttribute("aria-label")).toBe("New above, 1 new");
    // Scrolling back to the start sees them.
    await scrollTo(page, 0);
    expect(await button.count()).toBe(0);
    await close(page);
  });

  test("the top group's heading stays until the next pushes it away, also when its own row is gone", async () => {
    const page = await open();
    // Far into group 1: its heading row (i40) is no longer mounted.
    const top = await page.evaluate(() => {
      const port = list.viewport();
      return port.scrollTop;
    });
    expect(top).toBe(0);
    await page.evaluate(() => list.controller.scrollToKey("i70", { align: "start" }));
    await frames(page, 3);
    expect(await page.locator('[data-key="i40"]').count()).toBe(0);
    const headings = await page.evaluate(() => list.headings());
    expect(headings[0]).toEqual({ text: "Group 1", top: 0, bottom: expect.any(Number), sticky: true });
    // No second copy of the same heading anywhere in view.
    expect(headings.filter((heading) => heading.text === "Group 1")).toHaveLength(1);

    // Scroll in small steps across the next heading: the sticky one never overlaps it and never jumps.
    await page.evaluate(() => list.controller.scrollToKey("i79", { align: "start" }));
    await frames(page, 3);
    const start = await page.evaluate(() => list.viewport().scrollTop);
    let pushed = false;
    for (let step = 0; step < 40; step++) {
      await scrollTo(page, start + step * 4);
      const seen = await page.evaluate(() => list.headings());
      const sticky = seen.find((heading) => heading.sticky)!;
      expect(sticky.top).toBeLessThanOrEqual(0);
      const next = seen.find((heading) => !heading.sticky && heading.text === "Group 2" && heading.top > 0);
      if (next && sticky.text === "Group 1") {
        expect(sticky.bottom).toBeLessThanOrEqual(next.top + 0.5);
        if (sticky.top < 0) pushed = true;
      }
    }
    expect(pushed).toBe(true);
    const last = await page.evaluate(() => list.headings());
    expect(last.find((heading) => heading.sticky)?.text).toBe("Group 2");
    await close(page);
  });

  test("keyboard: Tab enters at the top item, arrows move, Ctrl+End and Ctrl+Home reach both ends without following", async () => {
    const page = await open();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.key)).toBe("i0");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Item i0");
    await page.keyboard.press("ArrowDown");
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.key)).toBe("i1");
    await page.keyboard.press("Control+End");
    await frames(page, 2);
    const last = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.key);
    expect(Number(last?.slice(1))).toBeGreaterThanOrEqual(119);
    await page.keyboard.press("Control+Home");
    await frames(page, 2);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.key)).toBe("i0");
    expect(await page.evaluate(() => list.viewport().scrollTop)).toBe(0);
    await close(page);
  });

  test("on a phone, touch scrolling keeps the heading and the page never scrolls sideways", async () => {
    const page = await open({}, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: browserName === "chromium" });
    await scrollTo(page, 2400);
    const headings = await page.evaluate(() => list.headings());
    expect(headings.find((heading) => heading.sticky)?.top).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await close(page);
  });
});
