import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// Keeping the reading position is a layout result: rows measure in a real engine, and the probe reads every row's
// place at the end of each frame, after the feed's measure-and-correct pass and right before paint.
const packageRoot = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(packageRoot, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "virtual-feed.fixture.ts");
const fixture = `
import { createComponent, createEffect, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { LocaleProvider, VirtualFeed } from ${JSON.stringify(resolve(packageRoot, "dist/browser/index.js"))};

const options = window.fixtureOptions ?? {};
const visible = options.count ?? 300;
const older = options.older ?? 0;
const WORDS = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda omicron sigma omega".split(" ");
let state = 42;
const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
const make = (seq) => {
  const r = random();
  const lines = r < 0.6 ? 1 : r < 0.85 ? 2 + Math.floor(random() * 4) : 6 + Math.floor(random() * 10);
  const image = random() < 0.1;
  const words = [];
  let chars = 0;
  const target = lines === 1 ? 10 + Math.floor(random() * 50) : lines * 70 - Math.floor(random() * 40);
  while (chars < target) {
    const word = WORDS[Math.floor(random() * WORDS.length)];
    words.push(word);
    chars += word.length + 1;
  }
  return { id: "m" + seq, seq, lines: image ? 0 : lines, image, text: image ? "" : words.join(" "), grow: createSignal(0) };
};
const newer = options.newer ?? 0;
const all = Array.from({ length: older + visible + newer + (options.future ?? 1000) }, (_, seq) => make(seq));
const newest = older + visible + newer;
let first = older;
let next = older + visible;
const [items, setItems] = createSignal(all.slice(first, next));
let controller;
const [marker, setMarker] = createSignal(options.marker);
const row = (item) => {
  const element = document.createElement("div");
  element.className = "row";
  const author = document.createElement("div");
  author.className = "author";
  author.textContent = "Entry " + item.seq;
  element.append(author);
  if (item.image) {
    const box = document.createElement("div");
    box.className = "image";
    element.append(box);
  } else {
    const text = document.createElement("p");
    text.className = "text";
    text.textContent = item.text;
    element.append(text);
  }
  const extra = document.createElement("div");
  createEffect(() => (extra.style.height = item.grow[0]() + "px"));
  element.append(extra);
  return element;
};
const list = () =>
  createComponent(VirtualFeed, {
    get items() {
      return items();
    },
    getKey: (item) => item.id,
    estimateSize: (item) => 32 + (item.image ? 180 : item.lines * 20),
    label: "Activity",
    itemLabel: (item) => "Entry " + item.seq,
    get hasOlder() {
      return first > 0;
    },
    get hasNewer() {
      return next < newest;
    },
    onLoadNewer: () =>
      new Promise((done) =>
        setTimeout(() => {
          const page = all.slice(next, Math.min(newest, next + 50));
          next += page.length;
          setItems((current) => [...current, ...page]);
          done();
        }, 150),
      ),
    onLoadNewest: options.newest
      ? () =>
          new Promise((done) =>
            setTimeout(() => {
              first = newest - 100;
              next = newest;
              setItems(all.slice(first, next));
              done();
            }, 150),
          )
      : undefined,
    onLoadOlder: () =>
      new Promise((done) =>
        setTimeout(() => {
          const from = Math.max(0, first - 50);
          const page = all.slice(from, first);
          first = from;
          setItems((current) => [...page, ...current]);
          done();
        }, 150),
      ),
    // A day separator every fifth entry, so that several show at once.
    separator: options.separators
      ? (item, previous) =>
          !previous || Math.floor(item.seq / 5) !== Math.floor(previous.seq / 5) ? "Day " + Math.floor(item.seq / 5) : undefined
      : undefined,
    get markerKey() {
      return marker();
    },
    controller: (value) => (controller = value),
    children: (item) => row(item),
  });
render(
  () =>
    options.locale
      ? createComponent(LocaleProvider, {
          locale: options.locale,
          get children() {
            return list();
          },
        })
      : list(),
  document.getElementById("feed"),
);

// End-of-frame probe: a ResizeObserver created after the feed's own, fed by a 1 px element resized in every frame.
const viewport = () => document.querySelector(".k2b-virtual-feed__viewport");
const visibleRows = () => {
  const port = viewport().getBoundingClientRect();
  const out = new Map();
  for (const row of document.querySelectorAll(".k2b-virtual-feed__item")) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > port.top && rect.top < port.bottom) out.set(row.dataset.key, rect.top);
  }
  return out;
};
const gap = () => {
  const rows = [...document.querySelectorAll(".k2b-virtual-feed__item")];
  const last = rows.reduce((a, b) => (Number(b.dataset.index) > Number(a.dataset.index) ? b : a));
  return viewport().getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
};
const ping = document.createElement("div");
ping.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none";
document.body.append(ping);
let record = null;
let frame = 0;
new ResizeObserver(() => {
  if (!record) return;
  record.frames++;
  if (record.watch) {
    const row = document.querySelector('[data-key="' + record.watch + '"]');
    record.tops.push(row ? row.getBoundingClientRect().top : NaN);
  }
  if (record.gap) record.gaps.push(gap());
  const rows = visibleRows();
  const deltas = [];
  for (const [key, top] of rows) if (record.previous.has(key)) deltas.push(top - record.previous.get(key));
  if (deltas.length > 1) record.spread = Math.max(record.spread, Math.max(...deltas) - Math.min(...deltas));
  record.previous = rows;
}).observe(ping);
const loop = () => {
  ping.style.height = ping.style.height === "2px" ? "1px" : "2px";
  frame = requestAnimationFrame(loop);
};
window.probe = {
  start(watch, withGap) {
    record = { frames: 0, tops: [], gaps: [], spread: 0, previous: visibleRows(), watch, gap: withGap };
    cancelAnimationFrame(frame);
    loop();
  },
  stop() {
    cancelAnimationFrame(frame);
    const r = record;
    record = null;
    const base = r.tops[0];
    return {
      frames: r.frames,
      drift: r.watch ? Math.max(0, ...r.tops.map((top) => Math.abs(top - base))) : 0,
      missing: r.tops.filter((top) => Number.isNaN(top)).length,
      gapMin: r.gaps.length ? Math.min(...r.gaps) : 0,
      gapMax: r.gaps.length ? Math.max(...r.gaps) : 0,
      spread: r.spread,
      tops: r.tops,
    };
  },
  gap,
  topVisible() {
    const port = viewport().getBoundingClientRect();
    const rows = [...document.querySelectorAll(".k2b-virtual-feed__item")]
      .map((row) => [row, row.getBoundingClientRect()])
      .filter(([, rect]) => rect.top >= port.top - 0.5 && rect.bottom <= port.bottom)
      .sort((a, b) => a[1].top - b[1].top);
    return rows[0]?.[0].dataset.key;
  },
};
window.feed = {
  get controller() {
    return controller;
  },
  viewport,
  count: () => items().length,
  append(count) {
    const page = all.slice(next, next + count);
    next += count;
    setItems((current) => [...current, ...page]);
  },
  grow(key, px) {
    all.find((item) => item.id === key).grow[1](px);
  },
  setMarker,
  replace(key, seq) {
    setItems((current) => current.map((item) => (item.id === key ? { ...item, seq } : item)));
  },
  swap(a, b) {
    setItems((current) => {
      const next = [...current];
      const i = next.findIndex((item) => item.id === a);
      const j = next.findIndex((item) => item.id === b);
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  },
};
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the VirtualFeed fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type Probe = {
  start: (watch?: string, withGap?: boolean) => void;
  stop: () => { frames: number; drift: number; missing: number; gapMin: number; gapMax: number; spread: number };
  gap: () => number;
  topVisible: () => string;
};
type Feed = {
  controller: {
    scrollToKey: (key: string, options?: { align?: "start" | "center"; highlight?: boolean }) => boolean;
    scrollToEnd: () => void;
    isAtEnd: () => boolean;
  };
  viewport: () => HTMLElement;
  count: () => number;
  append: (count: number) => void;
  grow: (key: string, px: number) => void;
  setMarker: (key: string | undefined) => void;
  replace: (key: string, seq: number) => void;
  swap: (a: string, b: string) => void;
};
declare const probe: Probe;
declare const feed: Feed;

const open = async (
  options: {
    count?: number;
    older?: number;
    newer?: number;
    newest?: boolean;
    future?: number;
    locale?: string;
    separators?: boolean;
    marker?: string;
  } = {},
  context: BrowserContextOptions = {},
): Promise<Page> => {
  const page = await (await browser.newContext({ viewport: { width: 720, height: 800 }, ...context })).newPage();
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}
html, body { margin: 0; height: 100%; }
#app { display: flex; flex-direction: column; height: 100vh; }
#feed { display: flex; min-height: 0; flex: 1; }
.composer { flex: none; height: var(--composer, 56px); }
.row { padding: 6px 12px; font: 14px/20px sans-serif; }
.author { height: 18px; font-size: 12px; line-height: 18px; }
.text { margin: 0; overflow-wrap: anywhere; }
.image { width: 320px; height: 180px; background: #9ab; }
</style></head><body class="k2b-ui"><div id="app"><div id="feed"></div><div class="composer"></div></div></body></html>`,
  );
  await page.addScriptTag({ content: `window.fixtureOptions = ${JSON.stringify(options)};` });
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-virtual-feed__item").first().waitFor();
  await frames(page, 4);
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
/** Scrolls as the reader does; the feed tells it from its own corrections by the changed scrollTop. */
const scrollBy = (page: Page, dy: number) => page.evaluate((dy) => feed.viewport().scrollBy(0, dy), dy);

describe(`VirtualFeed in ${browserName}`, () => {
  test("starts at the end and stays there when an item arrives, the last row grows, or the footer grows", async () => {
    const page = await open();
    expect(Math.abs(await page.evaluate(() => probe.gap()))).toBeLessThanOrEqual(1);

    await page.evaluate(() => probe.start(undefined, true));
    await page.evaluate(() => feed.append(1));
    await frames(page, 6);
    await page.evaluate(() => feed.grow(`m${feed.count() - 1}`, 120));
    await frames(page, 6);
    // A growing composer: the viewport shrinks by 84 px, step by step, then grows back.
    for (const px of [70, 98, 112, 140, 56]) {
      await page.evaluate((px) => document.documentElement.style.setProperty("--composer", `${px}px`), px);
      await frames(page, 2);
    }
    const run = await page.evaluate(() => probe.stop());
    expect(run.frames).toBeGreaterThan(10);
    expect(run.gapMin).toBeGreaterThanOrEqual(-1);
    expect(run.gapMax).toBeLessThanOrEqual(1);
    expect(await page.locator(".k2b-virtual-feed__end").count()).toBe(0);
    await page.close();
  });

  test("stays at the end when the viewport shrinks by 336 px, like an on-screen keyboard", async () => {
    const page = await open();
    await page.evaluate(() => probe.start(undefined, true));
    await page.setViewportSize({ width: 720, height: 800 - 336 });
    await frames(page, 6);
    await page.setViewportSize({ width: 720, height: 800 });
    await frames(page, 6);
    const run = await page.evaluate(() => probe.stop());
    expect(run.gapMin).toBeGreaterThanOrEqual(-1);
    expect(run.gapMax).toBeLessThanOrEqual(1);
    await page.close();
  });

  test("never moves a reader who scrolled up: new items, rows growing above, and a shorter viewport", async () => {
    const page = await open();
    await scrollBy(page, -3000);
    await frames(page, 6);
    const watch = await page.evaluate(() => probe.topVisible());
    expect(await page.evaluate(() => feed.controller.isAtEnd())).toBe(false);

    await page.evaluate((watch) => probe.start(watch), watch);
    await page.evaluate(() => feed.append(5));
    await frames(page, 10);
    // A row above the visible ones gets late content, like a link preview.
    const above = await page.evaluate((watch) => `m${Number(watch.slice(1)) - 3}`, watch);
    await page.evaluate((key) => feed.grow(key, 120), above);
    await frames(page, 10);
    const run = await page.evaluate(() => probe.stop());
    expect(run.missing).toBe(0);
    expect(run.drift).toBeLessThanOrEqual(1);
    expect(run.spread).toBeLessThanOrEqual(1);

    const end = page.locator(".k2b-virtual-feed__end");
    expect(await end.getAttribute("aria-label")).toBe("Jump to latest, 5 new");
    expect(await end.locator(".k2b-virtual-feed__count").textContent()).toBe("5");
    await end.click();
    await frames(page, 4);
    expect(Math.abs(await page.evaluate(() => probe.gap()))).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.key)).toBe("m304");
    await page.close();
  });

  test("keeps a scroll that happened just before new items arrived in the same frame", async () => {
    const page = await open();
    // The scroll event of this scroll runs only after the append, so the feed must notice the scroll itself.
    await page.evaluate(() => {
      feed.viewport().scrollTop -= 800;
      feed.append(2);
    });
    await frames(page, 4);
    expect(await page.evaluate(() => feed.controller.isAtEnd())).toBe(false);
    const fromEnd = await page.evaluate(() => {
      const port = feed.viewport();
      return port.scrollHeight - port.scrollTop - port.clientHeight;
    });
    expect(fromEnd).toBeGreaterThan(700);
    await page.close();
  });

  test("holds the position to the pixel while older pages load above", async () => {
    const page = await open({ count: 120, older: 50 });
    await page.evaluate(() => {
      feed.viewport().scrollTop = 0;
    });
    // The scroll reaches the start, so the first older page is loading now.
    await page.locator('[role="feed"][aria-busy="true"]').waitFor();
    const watch = await page.evaluate(() => probe.topVisible());
    expect(await page.locator(`[data-key="${watch}"]`).getAttribute("aria-setsize")).toBe("-1");
    expect(await page.locator(`[data-key="${watch}"]`).getAttribute("aria-posinset")).toBeNull();
    await page.evaluate((watch) => probe.start(watch), watch);
    await page.waitForFunction(() => feed.count() === 170, null, { timeout: 10_000 });
    await page.locator('[role="feed"][aria-busy="false"]').waitFor();
    await frames(page, 10);
    const run = await page.evaluate(() => probe.stop());
    expect(run.missing).toBe(0);
    expect(run.drift).toBeLessThanOrEqual(1);
    expect(run.spread).toBeLessThanOrEqual(1);
    // Before the load, positions were unknown (aria-setsize -1); now the whole feed is loaded and they are exact.
    const watched = page.locator(`[data-key="${watch}"]`);
    expect(await watched.getAttribute("aria-posinset")).toBe(String(Number(watch.slice(1)) + 1));
    expect(await watched.getAttribute("aria-setsize")).toBe("170");
    await page.close();
  });

  test("jumps to an item by key, highlights it briefly, and nothing moves afterwards", async () => {
    const page = await open({ count: 2000 });
    expect(await page.evaluate(() => feed.controller.scrollToKey("missing"))).toBe(false);
    await page.evaluate(() => probe.start("m300"));
    expect(await page.evaluate(() => feed.controller.scrollToKey("m300", { highlight: true }))).toBe(true);
    await frames(page, 60);
    const run = await page.evaluate(() => probe.stop());
    expect(run.missing).toBe(0);
    // The first frame is the jump itself; from there on the item stays where it landed.
    const landed = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>('[data-key="m300"]')!.getBoundingClientRect();
      const port = feed.viewport().getBoundingClientRect();
      return { top: row.top - port.top, bottom: port.bottom - row.bottom };
    });
    expect(Math.abs(landed.top - landed.bottom)).toBeLessThanOrEqual(2);
    expect(run.spread).toBeLessThanOrEqual(1);
    const highlighted = page.locator('[data-key="m300"]');
    expect(await highlighted.getAttribute("data-highlighted")).toBe("");
    await page.waitForFunction(() => !document.querySelector('[data-key="m300"]')?.hasAttribute("data-highlighted"), null, {
      timeout: 3_000,
    });
    const settled = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>('[data-key="m300"]')!.getBoundingClientRect();
      return row.top - feed.viewport().getBoundingClientRect().top;
    });
    expect(Math.abs(settled - landed.top)).toBeLessThanOrEqual(1);
    await page.close();
  });

  test("exposes a feed of articles, keeps the focused row mounted, and bundles announcements", async () => {
    const page = await open();
    const feedElement = page.locator('[role="feed"]');
    expect(await feedElement.getAttribute("aria-label")).toBe("Activity");
    expect(await page.locator(".k2b-virtual-feed__viewport").getAttribute("tabindex")).toBe("-1");
    expect(await page.locator('[role="article"][tabindex="0"]').count()).toBe(1);
    expect(await page.locator('[role="article"]').first().getAttribute("aria-setsize")).toBe("300");

    // Tab lands on the newest visible item, arrows move between items, and the view follows.
    await page.keyboard.press("Tab");
    const active = () =>
      page.evaluate(() => {
        const element = document.activeElement as HTMLElement;
        const rect = element.getBoundingClientRect();
        const port = feed.viewport().getBoundingClientRect();
        return {
          role: element.getAttribute("role"),
          key: element.dataset.key,
          posinset: element.getAttribute("aria-posinset"),
          inView: rect.top >= port.top - 1 && rect.bottom <= port.bottom + 1,
        };
      });
    expect(await active()).toEqual({ role: "article", key: "m299", posinset: "300", inView: true });
    for (let step = 0; step < 30; step++) await page.keyboard.press("ArrowUp");
    expect(await active()).toEqual({ role: "article", key: "m269", posinset: "270", inView: true });

    // Scrolled far away, the focused row stays in the document, and the next arrow brings it back.
    await scrollBy(page, -8000);
    await frames(page, 6);
    expect((await active()).key).toBe("m269");
    await page.keyboard.press("ArrowUp");
    expect(await active()).toEqual({ role: "article", key: "m268", posinset: "269", inView: true });

    await page.keyboard.press("Control+End");
    await frames(page, 4);
    expect((await active()).key).toBe("m299");
    expect(Math.abs(await page.evaluate(() => probe.gap()))).toBeLessThanOrEqual(1);

    // Reordered items move nodes; the focused one keeps focus.
    await page.evaluate(() => feed.swap("m298", "m299"));
    await frames(page, 2);
    expect((await active()).key).toBe("m299");

    // Three items within a second become one polite announcement.
    await page.evaluate(() => {
      feed.append(2);
      feed.append(1);
    });
    await page.waitForFunction(() => document.querySelector('[role="log"]')?.textContent, null, { timeout: 3_000 });
    expect(await page.locator('[role="log"] > *').allTextContents()).toEqual(["3 new items"]);
    await page.close();
  });

  test("shows separators and the marker inside rows, and a marker going away above moves nothing", async () => {
    const page = await open({ separators: true, marker: "m250" });
    await page.evaluate(() => feed.controller.scrollToKey("m250", { align: "start" }));
    await frames(page, 4);
    const separators = await page.locator(".k2b-virtual-feed__separator").allTextContents();
    expect(separators.length).toBeGreaterThan(0);
    expect(separators.every((text) => /^Day \d+$/.test(text))).toBe(true);
    expect(await page.locator('[data-key="m250"] .k2b-virtual-feed__separator').textContent()).toBe("Day 50");
    expect(await page.locator('[data-key="m251"] .k2b-virtual-feed__separator').count()).toBe(0);
    expect(await page.locator('[data-key="m250"] .k2b-virtual-feed__marker').textContent()).toBe("New");
    // A replaced predecessor that now falls on the same day removes the separator.
    await page.evaluate(() => feed.replace("m249", 250));
    expect(await page.locator('[data-key="m250"] .k2b-virtual-feed__separator').count()).toBe(0);
    await page.evaluate(() => feed.replace("m249", 249));
    expect(await page.locator('[data-key="m250"] .k2b-virtual-feed__separator').textContent()).toBe("Day 50");

    // Scroll so that the marker sits just above the visible rows, then let it go away as when read elsewhere.
    await page.evaluate(() => {
      const port = feed.viewport();
      const marked = document.querySelector<HTMLElement>('[data-key="m250"]')!;
      port.scrollBy(0, marked.getBoundingClientRect().bottom - port.getBoundingClientRect().top + 4);
    });
    await frames(page, 6);
    const watch = await page.evaluate(() => probe.topVisible());
    await page.evaluate((watch) => probe.start(watch), watch);
    await page.evaluate(() => feed.setMarker(undefined));
    await frames(page, 10);
    const run = await page.evaluate(() => probe.stop());
    expect(
      await page
        .locator('[data-key="m250"]')
        .boundingBox()
        .then((box) => box!.y + box!.height),
    ).toBeLessThan(await page.evaluate(() => feed.viewport().getBoundingClientRect().top));
    expect(await page.locator(".k2b-virtual-feed__marker").count()).toBe(0);
    expect(run.drift).toBeLessThanOrEqual(1);
    expect(run.spread).toBeLessThanOrEqual(1);
    await page.close();
  });

  test("speaks German inside a German locale", async () => {
    const page = await open({ locale: "de" });
    await scrollBy(page, -2000);
    await frames(page, 4);
    await page.evaluate(() => feed.append(2));
    const end = page.locator(".k2b-virtual-feed__end");
    expect(await end.getAttribute("aria-label")).toBe("Zum Neuesten, 2 neu");
    expect((await end.textContent())?.trim()).toBe("Zum Neuesten2");
    await page.waitForFunction(() => document.querySelector('[role="log"]')?.textContent, null, { timeout: 3_000 });
    expect(await page.locator('[role="log"] > *').allTextContents()).toEqual(["2 neue Einträge"]);
    await page.close();
  });

  test("Jump to latest reaches the newest item when it is not loaded yet, with or without onLoadNewest", async () => {
    for (const newest of [false, true]) {
      const page = await open({ count: 300, newer: 400, newest });
      const end = page.locator(".k2b-virtual-feed__end");
      expect(await page.evaluate(() => feed.controller.isAtEnd())).toBe(false);
      await end.click();
      // Without onLoadNewest the feed follows the end while newer pages arrive; with it, the newest page replaces them.
      await page.waitForFunction(() => document.querySelector('[data-key="m699"]'), null, { timeout: 10_000 });
      await page.locator('[role="feed"][aria-busy="false"]').waitFor();
      await frames(page, 6);
      expect(await page.evaluate(() => feed.count())).toBe(newest ? 100 : 700);
      expect(await page.evaluate(() => feed.controller.isAtEnd())).toBe(true);
      expect(Math.abs(await page.evaluate(() => probe.gap()))).toBeLessThanOrEqual(1);
      expect(await end.count()).toBe(0);
      await page.close();
    }
  });

  test("holds corrections back while an iOS finger or momentum scroll is moving the list", async () => {
    const iPhone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    const page = await open({}, { userAgent: iPhone });
    await scrollBy(page, -3000);
    await frames(page, 6);
    const watch = await page.evaluate(() => probe.topVisible());
    const above = await page.evaluate((watch) => `m${Number(watch.slice(1)) - 3}`, watch);
    const before = await page.evaluate(() => feed.viewport().scrollTop);
    const top = (key: string) => page.evaluate((key) => document.querySelector(`[data-key="${key}"]`)!.getBoundingClientRect().top, key);
    const resting = await top(watch);

    await page.evaluate(() => feed.viewport().dispatchEvent(new Event("touchstart")));
    await page.evaluate((key) => feed.grow(key, 100), above);
    await frames(page, 4);
    // Writing scrollTop now would stop iOS momentum, so the list lets the content move instead.
    expect(await page.evaluate(() => feed.viewport().scrollTop)).toBe(before);
    expect((await top(watch)) - resting).toBeCloseTo(100, 0);

    await page.evaluate(() => feed.viewport().dispatchEvent(new Event("touchend")));
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => feed.viewport().scrollTop)).toBeCloseTo(before + 100, 0);
    expect(Math.abs((await top(watch)) - resting)).toBeLessThanOrEqual(1);
    await page.close();
  });

  test("lays out 100,000 items in a bounded window and keeps the position when the window moves", async () => {
    const page = await open({ count: 100_000, future: 60_000 });
    const layout = await page.evaluate(() => ({
      height: (document.querySelector('[role="feed"]') as HTMLElement).offsetHeight,
      rows: document.querySelectorAll('[role="article"]').length,
      setsize: document.querySelector('[role="article"]')!.getAttribute("aria-setsize"),
    }));
    expect(layout.height).toBeLessThanOrEqual(8_000_000);
    expect(layout.height).toBeGreaterThan(2_000_000);
    expect(layout.rows).toBeLessThan(60);
    expect(layout.setsize).toBe("100000");

    // Near the top of the loaded window, the window grows upwards while the reader keeps scrolling.
    await page.evaluate(() => {
      feed.viewport().scrollTop = 2_600;
    });
    await frames(page, 6);
    const watch = await page.evaluate(() => probe.topVisible());
    const startTop = await page.evaluate((key) => document.querySelector(`[data-key="${key}"]`)!.getBoundingClientRect().top, watch);
    await page.evaluate((watch) => probe.start(watch), watch);
    await scrollBy(page, -500);
    await frames(page, 10);
    const run = await page.evaluate(() => probe.stop());
    const grown = await page.evaluate(() => feed.viewport().scrollTop);
    expect(grown).toBeGreaterThan(1_000_000);
    expect(run.missing).toBe(0);
    expect(run.spread).toBeLessThanOrEqual(1);
    const endTop = await page.evaluate((key) => document.querySelector(`[data-key="${key}"]`)!.getBoundingClientRect().top, watch);
    expect(Math.abs(endTop - startTop - 500)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => (document.querySelector('[role="feed"]') as HTMLElement).offsetHeight)).toBeLessThanOrEqual(8_000_000);

    // Following the end, appended items push the window forward instead of growing it past the cap.
    await page.locator(".k2b-virtual-feed__end").click();
    await frames(page, 4);
    await page.evaluate(() => feed.append(60_000));
    await frames(page, 6);
    expect(await page.evaluate(() => (document.querySelector('[role="feed"]') as HTMLElement).offsetHeight)).toBeLessThanOrEqual(8_000_000);
    expect(Math.abs(await page.evaluate(() => probe.gap()))).toBeLessThanOrEqual(1);

    // A jump to the very first item moves the window there, and Jump to latest comes back.
    expect(await page.evaluate(() => feed.controller.scrollToKey("m0", { align: "start" }))).toBe(true);
    await frames(page, 6);
    expect(await page.locator('[data-key="m0"]').getAttribute("aria-posinset")).toBe("1");
    await page.locator(".k2b-virtual-feed__end").click();
    await frames(page, 6);
    expect(Math.abs(await page.evaluate(() => probe.gap()))).toBeLessThanOrEqual(1);
    await page.close();
  }, 60_000);
});
