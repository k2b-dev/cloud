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
const [newest, setNewest] = createSignal(older + visible + newer);
let first = older;
let next = older + visible;
const [items, setItems] = createSignal(all.slice(first, next));
let controller;
// Window errors, such as a ResizeObserver loop that left notifications undelivered.
window.errors = [];
window.addEventListener("error", (event) => window.errors.push(event.message));
// Loads wait 150 ms, or with the manual option until the test calls feed.release(), so busy states can be asserted.
let gates = [];
const gate = () => (options.manual ? new Promise((done) => gates.push(done)) : new Promise((done) => setTimeout(done, 150)));
const [marker, setMarker] = createSignal(options.marker);
// Row content reads this signal while it renders, like content that depends on a selection.
const [tick, setTick] = createSignal(0);
let created = 0;
const row = (item) => {
  tick();
  created++;
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
    estimateSize: (item) => (32 + (item.image ? 180 : item.lines * 20)) * (options.estimateScale ?? 1),
    label: "Activity",
    itemLabel: (item) => "Entry " + item.seq,
    get hasOlder() {
      return first > 0;
    },
    onLoadOlder: () => {
      const prepend = () => {
        const from = Math.max(0, first - 50);
        const page = all.slice(from, first);
        first = from;
        setItems((current) => [...page, ...current]);
      };
      // With the cached option the older page is already there and arrives synchronously.
      if (options.cached) return prepend();
      return gate().then(prepend);
    },
    get hasNewer() {
      return next < newest();
    },
    onLoadNewer: options.noNewer
      ? undefined
      : () =>
          gate().then(() => {
            if (options.failNewer) throw new Error("offline");
            const page = all.slice(next, Math.min(newest(), next + 50));
            next += page.length;
            setItems((current) => [...current, ...page]);
          }),
    onLoadNewest: options.newest
      ? () =>
          gate().then(() => {
            if (options.newest === "fail") throw new Error("offline");
            first = newest() - 100;
            next = newest();
            setItems(all.slice(first, next));
          })
      : undefined,
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

// End-of-frame probe: a ResizeObserver created after the feed's own, fed by a 1 px element resized in every frame. It
// reads the content of rows, below any separator or marker, because that is what the reader reads.
const viewport = () => document.querySelector(".k2b-virtual-feed__viewport");
const contentTop = (key) => {
  const content = document.querySelector('[data-key="' + key + '"] .row');
  return content ? content.getBoundingClientRect().top : NaN;
};
const visibleRows = () => {
  const port = viewport().getBoundingClientRect();
  const out = new Map();
  for (const row of document.querySelectorAll(".k2b-virtual-feed__item")) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > port.top && rect.top < port.bottom) out.set(row.dataset.key, row.querySelector(".row").getBoundingClientRect().top);
  }
  return out;
};
/** Empty space between the top edge of the visible area and the first loaded item. */
const head = () => {
  const first = document.querySelector('.k2b-virtual-feed__item[data-index="0"]');
  return first ? Math.max(0, first.getBoundingClientRect().top - viewport().getBoundingClientRect().top) : 0;
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
  if (record.watch) record.tops.push(contentTop(record.watch));
  if (record.gap) record.gaps.push(gap());
  record.head = Math.max(record.head, head());
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
  // The positions at start are the base, so a shift in the same task as the change, before any frame, still counts.
  start(watch, withGap) {
    record = { frames: 0, tops: watch ? [contentTop(watch)] : [], gaps: [], head: 0, spread: 0, previous: visibleRows(), watch, gap: withGap };
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
      head: r.head,
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
  contentTop,
  count: () => items().length,
  created: () => created,
  bump: () => setTick((value) => value + 1),
  show(from, to) {
    first = from;
    next = to;
    setItems(all.slice(from, to));
  },
  append(count) {
    const page = all.slice(next, next + count);
    next += count;
    setItems((current) => [...current, ...page]);
  },
  grow(key, px) {
    all.find((item) => item.id === key).grow[1](px);
  },
  setMarker,
  setNewest,
  release() {
    const waiting = gates;
    gates = [];
    for (const done of waiting) done();
    return waiting.length;
  },
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

// The reader's scroll input, kept apart from the feed's own writes to scrollTop, which window.writes logs.
const port = viewport();
const nativeTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
let byPerson = false;
window.writes = [];
Object.defineProperty(port, "scrollTop", {
  configurable: true,
  get() {
    return nativeTop.get.call(this);
  },
  set(value) {
    const from = nativeTop.get.call(this);
    nativeTop.set.call(this, value);
    const to = nativeTop.get.call(this);
    if (!byPerson && Math.abs(to - from) >= 0.5) window.writes.push([Math.round(from), Math.round(to)]);
  },
});
// Both engines fire scrollend after every scroll, also a scripted one; held, it waits as during momentum.
let holding = false;
addEventListener("scrollend", (event) => holding && event.target === port && event.isTrusted && event.stopImmediatePropagation(), true);
const touch = (type, target, y) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { identifier: 1, target, clientX: 200, clientY: y };
  Object.defineProperty(event, "changedTouches", { value: [point] });
  Object.defineProperty(event, "touches", { value: type === "touchend" || type === "touchcancel" ? [] : [point] });
  target.dispatchEvent(event);
};
const nextFrame = () => new Promise((done) => requestAnimationFrame(done));
const rowAt = (y) => {
  const box = port.getBoundingClientRect();
  return document.elementFromPoint(box.left + 40, box.top + y)?.closest(".k2b-virtual-feed__item");
};
const actions = {
  keyboard: (px) => document.documentElement.style.setProperty("--composer", px + "px"),
  append: (count) => window.feed.append(count),
  // The row right above the visible ones gets late content.
  growAbove: (px) => window.feed.grow("m" + (Number(rowAt(1).dataset.key.slice(1)) - 1), px),
  // A scrollend that is not the end of this scroll, such as the late one of an earlier write.
  scrollend: () => port.dispatchEvent(new Event("scrollend")),
  send: () => {
    window.feed.append(1);
    controller.scrollToEnd();
  },
  release: () => touch("touchend", port, 400),
  probe: () => window.probe.start(undefined, true),
};
window.person = {
  to(top) {
    byPerson = true;
    port.scrollTop = top;
    byPerson = false;
  },
  by(dy) {
    window.person.to(nativeTop.get.call(port) + dy);
  },
  touch(type, target = port, y = 400) {
    touch(type, target, y);
  },
  hold() {
    holding = true;
  },
  /** The scroller's own end of the scroll. */
  end() {
    holding = false;
    port.dispatchEvent(new Event("scrollend"));
  },
  act(name, ...args) {
    actions[name](...args);
  },
  /** Key of the row at this height of the visible area. */
  keyAt: (y) => rowAt(y)?.dataset.key,
  /** How far the content of a row starts above the bottom edge of the visible area. */
  fromBottom(key) {
    const content = document.querySelector('[data-key="' + key + '"] .row');
    return content ? port.getBoundingClientRect().bottom - content.getBoundingClientRect().top : NaN;
  },
  /** A finger drag in frames of dy px, released without momentum. */
  async drag(steps, target = port) {
    touch("touchstart", target, 400);
    for (const dy of steps) {
      touch("touchmove", target, 400 - dy);
      window.person.by(dy);
      await nextFrame();
    }
    touch("touchend", target, 400);
  },
  /**
   * Momentum: one step per frame in a page-side loop, so harness latency cannot end it early. A step's actions run in
   * the same task as its move. toEnd glides along a decelerating curve to the end the list has when it starts. Records
   * the distance of a watched row from the bottom edge before every step, and the feed's writes until the last step.
   */
  async glide({ steps = [], toEnd = 0, actions: planned = {}, pause = {}, watch }) {
    const start = nativeTop.get.call(port);
    const target = port.scrollHeight - port.clientHeight;
    const moves = toEnd ? Array.from({ length: toEnd }, (_, i) => start + (target - start) * (1 - (1 - (i + 1) / toEnd) ** 2)) : steps;
    window.writes = [];
    const track = [];
    for (let i = 0; i < moves.length; i++) {
      track.push(watch ? window.person.fromBottom(watch) : 0);
      const before = nativeTop.get.call(port);
      if (toEnd) window.person.to(moves[i]);
      else window.person.by(moves[i]);
      track.push(nativeTop.get.call(port) - before);
      for (const [name, ...args] of planned[i + 1] ?? []) actions[name](...args);
      if (pause[i + 1]) await new Promise((done) => setTimeout(done, pause[i + 1]));
      await nextFrame();
    }
    track.push(watch ? window.person.fromBottom(watch) : 0);
    return { writes: window.writes, track };
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
  stop: () => {
    frames: number;
    drift: number;
    missing: number;
    gapMin: number;
    gapMax: number;
    head: number;
    spread: number;
    tops: number[];
  };
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
  contentTop: (key: string) => number;
  count: () => number;
  created: () => number;
  bump: () => void;
  show: (from: number, to: number) => void;
  append: (count: number) => void;
  grow: (key: string, px: number) => void;
  setMarker: (key: string | undefined) => void;
  setNewest: (count: number) => void;
  release: () => number;
  replace: (key: string, seq: number) => void;
  swap: (a: string, b: string) => void;
};
type Person = {
  to: (top: number) => void;
  by: (dy: number) => void;
  touch: (type: "touchstart" | "touchmove" | "touchend" | "touchcancel", target?: Element, y?: number) => void;
  hold: () => void;
  end: () => void;
  act: (name: "keyboard" | "append" | "growAbove" | "scrollend" | "send" | "release" | "probe", ...args: number[]) => void;
  keyAt: (y: number) => string;
  fromBottom: (key: string) => number;
  drag: (steps: number[], target?: Element) => Promise<void>;
  glide: (options: {
    steps?: number[];
    toEnd?: number;
    actions?: Record<number, Array<[string, ...number[]]>>;
    pause?: Record<number, number>;
    watch?: string;
  }) => Promise<{ writes: number[][]; track: number[] }>;
};
declare const probe: Probe;
declare const feed: Feed;
declare const person: Person;
declare const writes: number[][];
declare const errors: string[];

const open = async (
  options: {
    count?: number;
    older?: number;
    newer?: number;
    newest?: boolean | "fail";
    noNewer?: boolean;
    estimateScale?: number;
    manual?: boolean;
    failNewer?: boolean;
    future?: number;
    locale?: string;
    separators?: boolean;
    marker?: string;
    cached?: boolean;
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
/** Closes a page once nothing raised a window error, such as a ResizeObserver loop with undelivered notifications. */
const close = async (page: Page) => {
  expect(await page.evaluate(() => errors)).toEqual([]);
  await page.close();
};
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
    await close(page);
  }, 30_000);

  test("the frame probe sees a shift made in the same task as the change it watches", async () => {
    const page = await open();
    await scrollBy(page, -3000);
    await frames(page, 4);
    const watch = await page.evaluate(() => probe.topVisible());
    await page.evaluate((watch) => {
      probe.start(watch);
      feed.viewport().scrollTop += 200;
    }, watch);
    await frames(page, 4);
    expect((await page.evaluate(() => probe.stop())).drift).toBeGreaterThan(190);
    await close(page);
  }, 30_000);

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
    await close(page);
  }, 30_000);

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

    // A growing footer shortens the viewport; what sits at its bottom edge stays there.
    const atBottom = () =>
      page.evaluate(() => {
        const port = feed.viewport().getBoundingClientRect();
        const row = [...document.querySelectorAll<HTMLElement>(".k2b-virtual-feed__item")].find((element) => {
          const rect = element.getBoundingClientRect();
          return rect.top < port.bottom - 1 && rect.bottom >= port.bottom - 1;
        })!;
        return { key: row.dataset.key, fromBottom: port.bottom - row.getBoundingClientRect().top };
      });
    const before = await atBottom();
    await page.evaluate(() => document.documentElement.style.setProperty("--composer", "140px"));
    await frames(page, 4);
    const after = await page.evaluate((key) => {
      const port = feed.viewport().getBoundingClientRect();
      return port.bottom - document.querySelector(`[data-key="${key}"]`)!.getBoundingClientRect().top;
    }, before.key);
    expect(Math.abs(after - before.fromBottom)).toBeLessThanOrEqual(1);
    await page.evaluate(() => document.documentElement.style.setProperty("--composer", "56px"));
    await frames(page, 4);

    const end = page.locator(".k2b-virtual-feed__end");
    expect(await end.getAttribute("aria-label")).toBe("Jump to latest, 5 new");
    expect(await end.locator(".k2b-virtual-feed__count").textContent()).toBe("5");
    await end.click();
    await frames(page, 4);
    expect(Math.abs(await page.evaluate(() => probe.gap()))).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.key)).toBe("m304");
    await close(page);
  }, 30_000);

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
    await close(page);
  }, 30_000);

  test("holds the position to the pixel while older pages load above", async () => {
    const page = await open({ count: 120, older: 50, manual: true });
    await page.evaluate(() => {
      feed.viewport().scrollTop = 0;
    });
    // The scroll reaches the start, so the older page is loading until the test releases it.
    await page.locator('[role="feed"][aria-busy="true"]').waitFor();
    const watch = await page.evaluate(() => probe.topVisible());
    expect(await page.locator(`[data-key="${watch}"]`).getAttribute("aria-setsize")).toBe("-1");
    expect(await page.locator(`[data-key="${watch}"]`).getAttribute("aria-posinset")).toBeNull();
    await page.evaluate((watch) => probe.start(watch), watch);
    expect(await page.evaluate(() => feed.release())).toBe(1);
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
    await close(page);
  }, 30_000);

  test("jumps to an item by key, highlights it briefly, and nothing moves afterwards", async () => {
    const page = await open({ count: 2000 });
    expect(await page.evaluate(() => feed.controller.scrollToKey("missing"))).toBe(false);
    // The probe starts right after the jump, so its first frame is the landing.
    const jumped = await page.evaluate(() => {
      const found = feed.controller.scrollToKey("m300", { highlight: true });
      probe.start("m300");
      return { found, highlighted: document.querySelector('[data-key="m300"]')?.getAttribute("data-highlighted") };
    });
    expect(jumped).toEqual({ found: true, highlighted: "" });
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
    expect(run.drift).toBeLessThanOrEqual(1);
    expect(run.spread).toBeLessThanOrEqual(1);
    await page.waitForFunction(() => !document.querySelector('[data-key="m300"]')?.hasAttribute("data-highlighted"), null, {
      timeout: 10_000,
    });
    const settled = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>('[data-key="m300"]')!.getBoundingClientRect();
      return row.top - feed.viewport().getBoundingClientRect().top;
    });
    expect(Math.abs(settled - landed.top)).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);

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

    // An item replaced under the same key, as by an edit or a reaction, keeps focus on its new row.
    await page.evaluate(() => feed.replace("m299", 299));
    await frames(page, 2);
    expect(await active()).toEqual({ role: "article", key: "m299", posinset: "300", inView: true });
    await page.keyboard.press("ArrowUp");
    expect((await active()).key).toBe("m298");
    // Row content that reads a signal while it renders is created once, as with Solid's For.
    const created = await page.evaluate(() => feed.created());
    await page.evaluate(() => feed.bump());
    expect(await page.evaluate(() => feed.created())).toBe(created);
    expect((await active()).key).toBe("m298");
    await page.keyboard.press("ArrowDown");

    // Reordered items move nodes; the focused one keeps focus.
    await page.evaluate(() => feed.swap("m298", "m299"));
    await frames(page, 2);
    expect((await active()).key).toBe("m299");

    // Three items within a second become one polite announcement.
    await page.evaluate(() => {
      feed.append(2);
      feed.append(1);
    });
    await page.waitForFunction(() => document.querySelector('[role="log"]')?.textContent, null, { timeout: 10_000 });
    expect(await page.locator('[role="log"] > *').allTextContents()).toEqual(["3 new items"]);
    await close(page);
  }, 30_000);

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
    await close(page);
  }, 30_000);

  test("leaves the end without moving when newer items appear that only onLoadNewest can load", async () => {
    const page = await open({ newest: true, noNewer: true });
    const watch = await page.evaluate(() => probe.topVisible());
    await page.evaluate((watch) => probe.start(watch), watch);
    await page.evaluate(() => feed.setNewest(400));
    await frames(page, 2);
    expect(await page.evaluate(() => feed.controller.isAtEnd())).toBe(false);
    // Nothing follows the end now; the last row growing keeps what is visible in place.
    await page.evaluate(() => feed.grow("m299", 50));
    await frames(page, 6);
    const run = await page.evaluate(() => probe.stop());
    expect(run.missing).toBe(0);
    expect(run.drift).toBeLessThanOrEqual(1);
    expect(run.spread).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);

  test("leaves the end without moving when a newer page it followed fails", async () => {
    const page = await open({ failNewer: true, manual: true });
    await page.evaluate(() => feed.setNewest(400));
    await page.locator('[role="feed"][aria-busy="true"]').waitFor();
    const watch = await page.evaluate(() => probe.topVisible());
    await page.evaluate((watch) => probe.start(watch), watch);
    expect(await page.evaluate(() => feed.release())).toBe(1);
    await page.locator('[role="feed"][aria-busy="false"]').waitFor();
    await frames(page, 2);
    expect(await page.evaluate(() => feed.controller.isAtEnd())).toBe(false);
    await page.evaluate(() => feed.grow("m299", 50));
    await frames(page, 6);
    const run = await page.evaluate(() => probe.stop());
    expect(run.missing).toBe(0);
    expect(run.drift).toBeLessThanOrEqual(1);
    expect(run.spread).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);

  test("keeps the content of the top item in place when a separator appears above it with an older page", async () => {
    const page = await open({ count: 120, older: 50, separators: true, manual: true });
    await page.evaluate(() => {
      feed.viewport().scrollTop = 0;
    });
    await page.locator('[role="feed"][aria-busy="true"]').waitFor();
    // While older items may come, the first loaded item has no known predecessor and so no separator.
    expect(await page.locator('[data-key="m50"] .k2b-virtual-feed__separator').count()).toBe(0);
    await page.evaluate(() => probe.start("m50"));
    expect(await page.evaluate(() => feed.release())).toBe(1);
    await page.waitForFunction(() => feed.count() === 170, null, { timeout: 10_000 });
    await frames(page, 10);
    const run = await page.evaluate(() => probe.stop());
    expect(await page.locator('[data-key="m50"] .k2b-virtual-feed__separator').textContent()).toBe("Day 10");
    expect(run.missing).toBe(0);
    expect(run.drift).toBeLessThanOrEqual(1);
    expect(run.spread).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);

  test("keeps the content of the top item in place when its marker goes away", async () => {
    // A conversation opens at the first unread item, then marks everything read.
    const page = await open({ separators: true, marker: "m252" });
    await page.evaluate(() => feed.controller.scrollToKey("m252", { align: "start" }));
    await frames(page, 4);
    expect(await page.locator('[data-key="m252"] .k2b-virtual-feed__marker').count()).toBe(1);
    await page.evaluate(() => probe.start("m252"));
    await page.evaluate(() => feed.setMarker(undefined));
    await frames(page, 6);
    const run = await page.evaluate(() => probe.stop());
    expect(await page.locator(".k2b-virtual-feed__marker").count()).toBe(0);
    expect(run.missing).toBe(0);
    expect(run.drift).toBeLessThanOrEqual(1);
    expect(run.spread).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);

  test("counts and announces items after the newest one it showed, not older pages loaded toward the end", async () => {
    const page = await open({ count: 300, newer: 100 });
    const toLoadedEnd = () =>
      page.evaluate(() => {
        const port = feed.viewport();
        port.scrollTop = port.scrollHeight;
      });
    await toLoadedEnd();
    await page.waitForFunction(() => feed.count() === 350, null, { timeout: 10_000 });
    await frames(page, 2);
    const end = page.locator(".k2b-virtual-feed__end");
    expect(await end.getAttribute("aria-label")).toBeNull();
    expect(await end.locator(".k2b-virtual-feed__count").count()).toBe(0);
    await toLoadedEnd();
    await page.waitForFunction(() => feed.count() === 400, null, { timeout: 10_000 });
    await page.locator('[role="feed"][aria-busy="false"]').waitFor();
    await toLoadedEnd();
    await frames(page, 4);
    expect(await page.evaluate(() => feed.controller.isAtEnd())).toBe(true);
    // Only the items that arrive now are new; announcements are bundled per second, so the pages would have joined them.
    await page.evaluate(() => feed.append(2));
    await page.waitForFunction(() => document.querySelector('[role="log"]')?.textContent, null, { timeout: 10_000 });
    expect(await page.locator('[role="log"] > *').allTextContents()).toEqual(["2 new items"]);
    await close(page);
  }, 30_000);

  test("drops a pending announcement when the feed switches to other items", async () => {
    const page = await open();
    await page.evaluate(() => {
      feed.append(2);
      feed.show(1000, 1100);
      feed.append(1);
    });
    await page.waitForFunction(() => document.querySelector('[role="log"]')?.textContent, null, { timeout: 10_000 });
    expect(await page.locator('[role="log"] > *').allTextContents()).toEqual(["1 new item"]);
    await close(page);
  }, 30_000);

  test("fills the view after a jump even when rows are far smaller than estimated", async () => {
    const page = await open({ count: 2000, estimateScale: 25 });
    expect(await page.evaluate(() => feed.controller.scrollToKey("m300", { align: "start" }))).toBe(true);
    await frames(page, 8);
    const view = await page.evaluate(() => {
      const port = feed.viewport().getBoundingClientRect();
      const rows = [...document.querySelectorAll<HTMLElement>(".k2b-virtual-feed__item")]
        .map((row) => row.getBoundingClientRect())
        .filter((rect) => rect.bottom > port.top && rect.top < port.bottom)
        .sort((a, b) => a.top - b.top);
      // How far rows that touch each other reach down from the top of the view.
      let reach = port.top;
      for (const rect of rows) if (rect.top <= reach + 1) reach = Math.max(reach, rect.bottom);
      return { uncovered: port.bottom - reach, top: feed.contentTop("m300") - port.top };
    });
    expect(view.uncovered).toBeLessThanOrEqual(1);
    expect(Math.abs(view.top)).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);

  for (const edge of ["start", "end"] as const) {
    test(`keeps an item that a jump could not center at the ${edge} where it landed when the next page loads`, async () => {
      const page = await open(edge === "start" ? { count: 300, older: 50, manual: true } : { count: 300, newer: 50, manual: true });
      const key = edge === "start" ? "m50" : "m298";
      expect(await page.evaluate((key) => feed.controller.scrollToKey(key), key)).toBe(true);
      // The jump lands near the edge, so the next page is loading until the test releases it.
      await page.locator('[role="feed"][aria-busy="true"]').waitFor();
      await frames(page, 2);
      await page.evaluate((key) => probe.start(key), key);
      expect(await page.evaluate(() => feed.release())).toBe(1);
      await page.waitForFunction(() => feed.count() === 350, null, { timeout: 10_000 });
      await frames(page, 10);
      const run = await page.evaluate(() => probe.stop());
      expect(run.missing).toBe(0);
      expect(run.drift).toBeLessThanOrEqual(1);
      expect(run.spread).toBeLessThanOrEqual(1);
      await close(page);
    }, 30_000);
  }

  test("keeps the top item in place when the viewport grows at the start and then a page loads above", async () => {
    const page = await open({ count: 300, older: 50, manual: true });
    await page.evaluate(() => document.documentElement.style.setProperty("--composer", "300px"));
    await frames(page, 4);
    await page.evaluate(() => {
      feed.viewport().scrollTop = 0;
    });
    await page.locator('[role="feed"][aria-busy="true"]').waitFor();
    const watch = await page.evaluate(() => probe.topVisible());
    await page.evaluate((watch) => probe.start(watch), watch);
    // The composer shrinks by 244 px: the top cannot move up, so what is at the top stays there.
    await page.evaluate(() => document.documentElement.style.setProperty("--composer", "56px"));
    await frames(page, 4);
    expect(await page.evaluate(() => feed.release())).toBe(1);
    await page.waitForFunction(() => feed.count() === 350, null, { timeout: 10_000 });
    await frames(page, 10);
    const run = await page.evaluate(() => probe.stop());
    expect(run.missing).toBe(0);
    expect(run.drift).toBeLessThanOrEqual(1);
    expect(run.spread).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);

  test("shows the items that an edge load adds synchronously while the feed mounts", async () => {
    const page = await open({ count: 20, older: 50, cached: true });
    expect(await page.evaluate(() => feed.count())).toBe(70);
    expect(await page.locator('[role="article"]').first().getAttribute("aria-setsize")).toBe("70");
    expect(await page.evaluate(() => feed.controller.scrollToKey("m10"))).toBe(true);
    await close(page);
  }, 30_000);

  test("moves focus to the item above when that move loads cached older items synchronously", async () => {
    const page = await open({ count: 300, older: 50, cached: true });
    // Scroll just past the margin in which the feed loads older items, and focus the row at the top of the view.
    await page.evaluate(() => {
      const port = feed.viewport();
      port.scrollTop = Math.max(2_000, 3 * port.clientHeight) + 300;
    });
    await frames(page, 2);
    const key = await page.evaluate(() => {
      const port = feed.viewport();
      const margin = Math.max(2_000, 3 * port.clientHeight);
      const list = document.querySelector('[role="feed"]')!.getBoundingClientRect().top;
      const row = [...document.querySelectorAll<HTMLElement>(".k2b-virtual-feed__item")]
        .map((element) => ({ element, offset: element.getBoundingClientRect().top - list }))
        .filter(({ offset }) => offset >= margin)
        .sort((a, b) => a.offset - b.offset)[0]!;
      port.scrollTop = row.offset;
      row.element.focus();
      return row.element.dataset.key!;
    });
    await frames(page, 2);
    expect(await page.evaluate(() => feed.count())).toBe(300);
    await page.keyboard.press("ArrowUp");
    await frames(page, 2);
    expect(await page.evaluate(() => feed.count())).toBe(350);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.key)).toBe(`m${Number(key.slice(1)) - 1}`);
    await close(page);
  }, 30_000);

  test("moves focus to a row below the view and shows all of it, even when the row is taller than estimated", async () => {
    const page = await open({ estimateScale: 0.4 });
    await page.keyboard.press("Tab");
    await scrollBy(page, -1500);
    await frames(page, 4);
    await page.evaluate(() => feed.append(2));
    await frames(page, 4);
    await page.keyboard.press("ArrowDown");
    await frames(page, 4);
    const focused = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      const rect = element.getBoundingClientRect();
      const port = feed.viewport().getBoundingClientRect();
      return { key: element.dataset.key, top: rect.top - port.top, bottom: port.bottom - rect.bottom };
    });
    expect(focused.key).toBe("m300");
    expect(focused.top).toBeGreaterThanOrEqual(-1);
    expect(Math.abs(focused.bottom)).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);

  test("speaks German inside a German locale", async () => {
    const page = await open({ locale: "de" });
    await scrollBy(page, -2000);
    await frames(page, 4);
    await page.evaluate(() => feed.append(2));
    const end = page.locator(".k2b-virtual-feed__end");
    expect(await end.getAttribute("aria-label")).toBe("Zum Neuesten, 2 neu");
    expect((await end.textContent())?.trim()).toBe("Zum Neuesten2");
    await page.waitForFunction(() => document.querySelector('[role="log"]')?.textContent, null, { timeout: 10_000 });
    expect(await page.locator('[role="log"] > *').allTextContents()).toEqual(["2 neue Einträge"]);
    await close(page);
  }, 30_000);

  for (const newest of [false, true]) {
    test(`Jump to latest reaches the newest item when it is not loaded yet ${newest ? "with" : "without"} onLoadNewest`, async () => {
      const page = await open({ count: 300, newer: 400, newest });
      const end = page.locator(".k2b-virtual-feed__end");
      expect(await page.evaluate(() => feed.controller.isAtEnd())).toBe(false);
      await end.click();
      // Without onLoadNewest the feed follows the end while newer pages arrive; with it, the newest page replaces them.
      await page.waitForFunction(() => document.querySelector('[data-key="m699"]'), null, { timeout: 15_000 });
      await page.locator('[role="feed"][aria-busy="false"]').waitFor();
      await frames(page, 6);
      expect(await page.evaluate(() => feed.count())).toBe(newest ? 100 : 700);
      expect(await page.evaluate(() => feed.controller.isAtEnd())).toBe(true);
      expect(Math.abs(await page.evaluate(() => probe.gap()))).toBeLessThanOrEqual(1);
      expect(await end.count()).toBe(0);
      await close(page);
    }, 30_000);
  }

  test("follows newer items in when a live update reports them while the reader is at the end", async () => {
    const page = await open();
    expect(await page.evaluate(() => feed.controller.isAtEnd())).toBe(true);
    // 100 newer items exist now, but none were added; the reader at the end pages them in.
    await page.evaluate(() => feed.setNewest(400));
    await page.waitForFunction(() => feed.count() === 400, null, { timeout: 15_000 });
    await page.locator('[role="feed"][aria-busy="false"]').waitFor();
    await frames(page, 6);
    expect(await page.evaluate(() => feed.controller.isAtEnd())).toBe(true);
    expect(Math.abs(await page.evaluate(() => probe.gap()))).toBeLessThanOrEqual(1);
    // They came after the newest item the feed had shown, so they are new, however the announcements are bundled.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[role="log"] > *')].reduce((sum, line) => sum + Number.parseInt(line.textContent ?? "0"), 0) === 100,
      null,
      { timeout: 10_000 },
    );
    await close(page);
  }, 30_000);

  test("shows Jump to latest again when loading the newest items fails", async () => {
    const page = await open({ count: 300, newer: 400, newest: "fail", manual: true });
    // The load fails in the task of the jump, so the scroll event of the jump arrives after the failure.
    const jumped = await page.evaluate(() => {
      document.querySelector<HTMLElement>(".k2b-virtual-feed__end")!.click();
      const busy = document.querySelector('[role="feed"]')!.getAttribute("aria-busy");
      const shown = document.querySelectorAll(".k2b-virtual-feed__end").length;
      // An item that changes meanwhile does not make the failed load look like a success.
      feed.replace("m299", 299);
      return { busy, shown, released: feed.release() };
    });
    expect(jumped).toEqual({ busy: "true", shown: 0, released: 1 });
    await frames(page, 4);
    // That scroll event is the feed's own and starts no newer page; only the reader's next scroll retries.
    expect(await page.evaluate(() => feed.release())).toBe(0);
    await page.locator('[role="feed"][aria-busy="false"]').waitFor();
    expect(await page.evaluate(() => feed.controller.isAtEnd())).toBe(false);
    expect(await page.locator(".k2b-virtual-feed__end").count()).toBe(1);
    await close(page);
  }, 30_000);

  test("shows Jump to latest for newer items that only onLoadNewest can load", async () => {
    const page = await open({ newest: true, noNewer: true });
    await page.evaluate(() => feed.setNewest(400));
    await page.locator(".k2b-virtual-feed__end").click();
    await page.waitForFunction(() => document.querySelector('[data-key="m399"]'), null, { timeout: 15_000 });
    await frames(page, 6);
    expect(await page.evaluate(() => feed.controller.isAtEnd())).toBe(true);
    expect(Math.abs(await page.evaluate(() => probe.gap()))).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);

  test("lets Jump to latest finish when a newer page it waits for fails", async () => {
    const page = await open({ count: 300, newer: 50, newest: true, failNewer: true, manual: true });
    await page.evaluate(() => {
      const port = feed.viewport();
      port.scrollTop = port.scrollHeight;
    });
    // The newer page is loading; Jump to latest waits for it, which then fails.
    await page.locator('[role="feed"][aria-busy="true"]').waitFor();
    await page.locator(".k2b-virtual-feed__end").click();
    expect(await page.evaluate(() => feed.release())).toBe(1);
    await page.waitForFunction(() => feed.release() > 0, null, { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector('[data-key="m349"]'), null, { timeout: 15_000 });
    await page.locator('[role="feed"][aria-busy="false"]').waitFor();
    await frames(page, 6);
    expect(await page.evaluate(() => feed.controller.isAtEnd())).toBe(true);
    expect(Math.abs(await page.evaluate(() => probe.gap()))).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);

  test("moves rows instead of the scroll position while a finger is on the feed, and writes it once the finger lifts", async () => {
    const page = await open();
    await scrollBy(page, -3000);
    await frames(page, 6);
    const watch = await page.evaluate(() => probe.topVisible());
    const above = await page.evaluate((watch) => `m${Number(watch.slice(1)) - 3}`, watch);
    const before = await page.evaluate(() => feed.viewport().scrollTop);
    const top = (key: string) => page.evaluate((key) => document.querySelector(`[data-key="${key}"]`)!.getBoundingClientRect().top, key);
    const resting = await top(watch);

    await page.evaluate(() => person.touch("touchstart"));
    await page.evaluate((key) => feed.grow(key, 100), above);
    await frames(page, 4);
    // Writing scrollTop now would fight the finger or its momentum, so the rows move and the content stays.
    expect(await page.evaluate(() => feed.viewport().scrollTop)).toBe(before);
    expect(Math.abs((await top(watch)) - resting)).toBeLessThanOrEqual(1);
    await page.evaluate(() => feed.append(1));
    await frames(page, 4);
    expect(await page.evaluate(() => feed.viewport().scrollTop)).toBe(before);

    // The finger lifts without having scrolled: the held-back correction is written, and nothing moves.
    await page.evaluate(() => person.touch("touchend"));
    await frames(page, 2);
    expect(Math.abs((await page.evaluate(() => feed.viewport().scrollTop)) - before - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs((await top(watch)) - resting)).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);

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
    // Every frame shows the row where it was or where the reader's scroll took it, never anywhere else.
    expect(run.tops.filter((top) => Math.abs(top - startTop) > 1 && Math.abs(top - startTop - 500) > 1)).toEqual([]);
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
    await close(page);
  }, 60_000);
});

// The scenarios that refuted earlier anchoring rules in the chat composer spike, ported to the feed: scroll input in
// the order engines deliver it, size changes landing in the same frame as the reader's scroll, momentum that keeps
// running after the finger lifts, and scrollend events that are not the end. A keyboard is the composer growing by
// 391 px; the suggestion row above it takes 44 px more. Momentum is simulated in one page-side frame loop; its
// scrollend is held back until the test ends it, as during momentum.
const KEYBOARD = 56 + 391;
const SUGGESTIONS = KEYBOARD + 44;
const isAtEnd = (page: Page) => page.evaluate(() => feed.controller.isAtEnd());
const endGap = (page: Page) => page.evaluate(() => probe.gap());
const fromBottom = (page: Page, key: string) => page.evaluate((key) => person.fromBottom(key), key);
/** Worst frame in which the watched row moved by more or less than the reader's own step. */
const unexplained = (track: number[]) => {
  let worst = 0;
  for (let index = 0; index + 2 < track.length; index += 2)
    worst = Math.max(worst, Math.abs(track[index + 2]! - track[index]! - track[index + 1]!));
  return worst;
};
/** Steps of a decelerating momentum tail, px per frame. */
const decelerate = (frames: number, speed: number) =>
  Array.from({ length: frames }, (_, index) => Math.round(speed * (1 - (index + 1) / frames)) + 1);
/** A finger drag that ends without momentum, then the time its scrollend needs. */
const dragBy = async (page: Page, px: number) => {
  await page.evaluate((px) => person.drag(Array.from({ length: Math.abs(px) / 100 }, () => Math.sign(px) * 100)), px);
  await page.waitForTimeout(300);
};
const inView = (page: Page, key: string) =>
  page.evaluate((key) => {
    const row = document.querySelector(`[data-key="${key}"]`)!.getBoundingClientRect();
    const port = feed.viewport().getBoundingClientRect();
    return row.top >= port.top - 1 && row.bottom <= port.bottom + 1;
  }, key);
/** The nearest row above the visible ones that fits into the view with the keyboard open. */
const rowAbove = (page: Page) =>
  page.evaluate(() => {
    let index = Number(person.keyAt(1).slice(1)) - 1;
    while (document.querySelector<HTMLElement>(`[data-key="m${index}"]`)!.offsetHeight > 300) index--;
    return `m${index}`;
  });

describe(`VirtualFeed keeps the reader's place under real scroll event orders in ${browserName}`, () => {
  test("A: stays at the end in every frame while the keyboard opens in 20 steps", async () => {
    const page = await open();
    await page.evaluate(() => probe.start(undefined, true));
    for (let step = 1; step <= 20; step++) {
      await page.evaluate((px) => person.act("keyboard", px), Math.round(56 + (391 * step) / 20));
      await frames(page, 1);
    }
    await frames(page, 4);
    const run = await page.evaluate(() => probe.stop());
    expect(run.gapMin).toBeGreaterThanOrEqual(-1);
    expect(run.gapMax).toBeLessThanOrEqual(1);
    expect(await isAtEnd(page)).toBe(true);
    await close(page);
  }, 30_000);

  for (const pause of [0, 200]) {
    test(`B: a fling to the end that the keyboard interrupts ends at the end and writes nothing while it runs${pause ? `, with a ${pause} ms pause in its events` : ""}`, async () => {
      const page = await open();
      await dragBy(page, -800);
      expect(await isAtEnd(page)).toBe(false);
      await page.evaluate(() => {
        person.hold();
        return person.drag([50, 50]);
      });
      // The tail glides to the end the list had at the release; the keyboard opens on its tenth frame.
      const tail = await page.evaluate(
        ([keyboard, pause]) => person.glide({ toEnd: 30, actions: { 10: [["keyboard", keyboard]] }, pause: pause ? { 10: pause } : {} }),
        [KEYBOARD, pause] as const,
      );
      expect(tail.writes).toEqual([]);
      await page.evaluate(() => person.end());
      await frames(page, 6);
      expect(await isAtEnd(page)).toBe(true);
      expect(Math.abs(await endGap(page))).toBeLessThanOrEqual(1);
      await page.evaluate(() => feed.append(1));
      await frames(page, 4);
      expect(Math.abs(await endGap(page))).toBeLessThanOrEqual(1);
      await close(page);
    }, 30_000);
  }

  test("X1: a fling to older items that the keyboard interrupts moves only by the reader's steps and does not jump when it ends", async () => {
    const page = await open();
    await dragBy(page, -800);
    const watch = await page.evaluate(() => person.keyAt(300));
    await page.evaluate(() => {
      person.hold();
      return person.drag([-50, -50]);
    });
    const tail = await page.evaluate(
      ([watch, steps, keyboard]) => person.glide({ steps, watch, actions: { 6: [["keyboard", keyboard]] } }),
      [watch, decelerate(20, 30).map((step) => -step), KEYBOARD] as const,
    );
    expect(tail.writes).toEqual([]);
    expect(unexplained(tail.track)).toBeLessThanOrEqual(1);
    const before = await fromBottom(page, watch);
    await page.evaluate(() => person.end());
    await frames(page, 8);
    expect(Math.abs((await fromBottom(page, watch)) - before)).toBeLessThanOrEqual(1);
    expect(await isAtEnd(page)).toBe(false);
    await close(page);
  }, 30_000);

  test("X6: the suggestion row appearing during a drag moves nothing the reader did not move, also when the drag ends", async () => {
    const page = await open();
    await page.evaluate((px) => person.act("keyboard", px), KEYBOARD);
    await frames(page, 4);
    await dragBy(page, -300);
    const watch = await page.evaluate(() => person.keyAt(150));
    const tail = await page.evaluate(
      ([watch, suggestions]) => {
        person.hold();
        person.touch("touchstart");
        return person.glide({
          steps: [-80, 0, -40, -5, -5, -5, -5, -5],
          watch,
          actions: { 2: [["keyboard", suggestions]], 3: [["release"]] },
        });
      },
      [watch, SUGGESTIONS] as const,
    );
    expect(tail.writes).toEqual([]);
    expect(unexplained(tail.track)).toBeLessThanOrEqual(1);
    const before = await fromBottom(page, watch);
    await page.evaluate(() => person.end());
    await frames(page, 8);
    expect(Math.abs((await fromBottom(page, watch)) - before)).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);

  for (const opened of [false, true]) {
    test(`${opened ? "F2: with the keyboard open, the suggestion row" : "F: the keyboard"} in the same frame as a scroll step at the end keeps the feed at the end`, async () => {
      const page = await open();
      if (opened) {
        await page.evaluate((px) => person.act("keyboard", px), KEYBOARD);
        await frames(page, 4);
      }
      // The reader's scroll tail sits one pixel from the end, which still counts as the end.
      await page.evaluate(async () => {
        person.hold();
        person.by(-40);
        await new Promise(requestAnimationFrame);
        person.by(39);
      });
      await frames(page, 2);
      expect(await isAtEnd(page)).toBe(true);
      await page.evaluate(() => probe.start(undefined, true));
      // Reading scrollTop lays out the new size before the scroll event of the step runs.
      await page.evaluate(
        (px) => {
          person.act("keyboard", px);
          person.by(1);
        },
        opened ? SUGGESTIONS : KEYBOARD,
      );
      await frames(page, 6);
      await page.evaluate(() => person.end());
      await frames(page, 6);
      const run = await page.evaluate(() => probe.stop());
      expect(run.gapMin).toBeGreaterThanOrEqual(-1);
      expect(run.gapMax).toBeLessThanOrEqual(1);
      expect(await isAtEnd(page)).toBe(true);
      await page.evaluate(() => feed.append(1));
      await frames(page, 4);
      expect(Math.abs(await endGap(page))).toBeLessThanOrEqual(1);
      await close(page);
    }, 30_000);
  }

  for (const [when, at, keyboard] of [
    ["before the keyboard opens", 5, true],
    ["after the keyboard opened", 15, true],
    ["without a keyboard", 15, false],
  ] as const) {
    test(`Y1: an item that arrives during a fling to the end ${when} still ends at the end, showing it`, async () => {
      const page = await open();
      await dragBy(page, -800);
      await page.evaluate(() => {
        person.hold();
        return person.drag([50, 50]);
      });
      const tail = await page.evaluate(
        ([at, keyboard]) => {
          const actions: Record<number, Array<[string, number]>> = { [at]: [["append", 1]] };
          if (keyboard) actions[10] = [["keyboard", keyboard]];
          return person.glide({ toEnd: 30, actions });
        },
        [at, keyboard ? KEYBOARD : 0] as const,
      );
      expect(tail.writes).toEqual([]);
      await page.evaluate(() => person.end());
      await frames(page, 6);
      expect(await isAtEnd(page)).toBe(true);
      expect(Math.abs(await endGap(page))).toBeLessThanOrEqual(1);
      expect(await page.locator('[data-key="m300"]').count()).toBe(1);
      await close(page);
    }, 30_000);
  }

  test("Y2: the late scrollend of the feed's own write does not end a later fling", async () => {
    const page = await open();
    // Following the end, the feed writes for a new item; the scrollend of that write arrives in the next fling.
    await page.evaluate(() => {
      person.hold();
      feed.append(1);
    });
    await frames(page, 2);
    const watch = await page.evaluate(() => person.keyAt(300));
    const tail = await page.evaluate(
      async ([watch, steps]) => {
        await person.drag([-60, -60, -60]);
        return person.glide({ steps, watch, actions: { 3: [["scrollend"]], 8: [["growAbove", 100]] } });
      },
      [watch, decelerate(20, 40).map((step) => -step)] as const,
    );
    expect(tail.writes).toEqual([]);
    expect(unexplained(tail.track)).toBeLessThanOrEqual(1);
    const before = await fromBottom(page, watch);
    await page.evaluate(() => person.end());
    await frames(page, 8);
    expect(Math.abs((await fromBottom(page, watch)) - before)).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);

  for (const tall of [true, false]) {
    test(`Y4: focus that moves to a ${tall ? "row taller than the view" : "row"} while the keyboard closes shows it`, async () => {
      const page = await open();
      await page.evaluate((px) => person.act("keyboard", px), KEYBOARD);
      await frames(page, 4);
      const key = await rowAbove(page);
      if (tall) {
        await page.evaluate((key) => feed.grow(key, 900), key);
        await frames(page, 4);
      }
      await page.evaluate((key) => {
        document.querySelector<HTMLElement>(`[data-key="${key}"]`)!.focus();
        person.act("keyboard", 56);
      }, key);
      await frames(page, 6);
      const shown = await page.evaluate((key) => {
        const row = document.querySelector(`[data-key="${key}"]`)!.getBoundingClientRect();
        const port = feed.viewport().getBoundingClientRect();
        return {
          focused: (document.activeElement as HTMLElement).dataset.key,
          overlap: Math.min(row.bottom, port.bottom) - Math.max(row.top, port.top),
        };
      }, key);
      expect(shown.focused).toBe(key);
      expect(shown.overlap).toBeGreaterThan(40);
      if (!tall) expect(await inView(page, key)).toBe(true);
      await close(page);
    }, 30_000);
  }

  for (const order of ["in the same task", "a frame later"]) {
    test(`shows a row that gets focus while the keyboard closes ${order}`, async () => {
      const page = await open();
      await page.evaluate((px) => person.act("keyboard", px), KEYBOARD);
      await frames(page, 4);
      const key = await rowAbove(page);
      await page.evaluate(
        async ([key, later]) => {
          document.querySelector<HTMLElement>(`[data-key="${key}"]`)!.focus();
          if (later) await new Promise(requestAnimationFrame);
          person.act("keyboard", 56);
        },
        [key, order !== "in the same task"] as const,
      );
      await frames(page, 6);
      expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.key)).toBe(key);
      expect(await inView(page, key)).toBe(true);
      await close(page);
    }, 30_000);
  }

  for (const up of [40, 200]) {
    test(`a size change that clamps the position does not count as the reader ${up} px from the end`, async () => {
      const page = await open();
      await page.evaluate(() => person.act("keyboard", 144));
      await frames(page, 4);
      await page.evaluate((up) => person.by(-up), up);
      await page.waitForTimeout(300);
      expect(await isAtEnd(page)).toBe(false);
      const watch = await page.evaluate(() => person.keyAt(300));
      const before = await fromBottom(page, watch);
      // The composer shrinks by 88 px, and reading the layout in the same task lets the engine clamp right away.
      await page.evaluate(() => {
        person.act("keyboard", 56);
        void document.body.offsetHeight;
      });
      await frames(page, 6);
      expect(await isAtEnd(page)).toBe(false);
      expect(Math.abs((await fromBottom(page, watch)) - before)).toBeLessThanOrEqual(1);
      await page.evaluate(() => feed.append(1));
      await frames(page, 4);
      expect(Math.abs((await fromBottom(page, watch)) - before)).toBeLessThanOrEqual(1);
      await close(page);
    }, 30_000);
  }

  test("follows the wheel and the keyboard: each scroll stays where it went, and End returns to the end", async () => {
    const page = await open();
    const top = () => page.evaluate(() => feed.viewport().scrollTop);
    const start = await top();
    await page.mouse.move(360, 400);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(400);
    const wheeled = await top();
    expect(wheeled).toBeLessThan(start - 100);
    await page.waitForTimeout(400);
    expect(await top()).toBe(wheeled);
    await page.evaluate(() => feed.viewport().focus());
    const tops: number[] = [];
    for (const key of ["PageUp", "PageUp", "PageDown", "ArrowUp", "ArrowUp", "ArrowUp"]) {
      await page.keyboard.press(key);
      await page.waitForTimeout(400);
      const moved = await top();
      await page.waitForTimeout(400);
      expect(await top()).toBe(moved);
      tops.push(moved);
    }
    expect(tops[0]).toBeLessThan(wheeled - 100);
    expect(tops[1]).toBeLessThan(tops[0]! - 100);
    expect(tops[2]).toBeGreaterThan(tops[1]!);
    expect(tops[3]).toBeLessThan(tops[2]!);
    expect(tops[5]).toBeLessThan(tops[4]!);
    const watch = await page.evaluate(() => person.keyAt(300));
    const before = await fromBottom(page, watch);
    await page.evaluate(() => feed.append(2));
    await frames(page, 4);
    expect(await fromBottom(page, watch)).toBe(before);
    await page.keyboard.press("End");
    await page.waitForTimeout(400);
    expect(await isAtEnd(page)).toBe(true);
    expect(Math.abs(await endGap(page))).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);

  for (const how of ["focus", "scrollIntoView"] as const) {
    test(`follows ${how} to a row above the view and keeps it in view through new items and the suggestion row`, async () => {
      const page = await open();
      await page.evaluate((px) => person.act("keyboard", px), KEYBOARD);
      await frames(page, 4);
      await dragBy(page, -1500);
      const key = await rowAbove(page);
      await page.evaluate(
        ([key, how]) => {
          const row = document.querySelector<HTMLElement>(`[data-key="${key}"]`)!;
          if (how === "focus") row.focus();
          else row.scrollIntoView({ block: "center" });
        },
        [key, how] as const,
      );
      await page.waitForTimeout(300);
      expect(await inView(page, key)).toBe(true);
      await page.evaluate(() => feed.append(2));
      await frames(page, 4);
      expect(await inView(page, key)).toBe(true);
      await page.evaluate((px) => person.act("keyboard", px), SUGGESTIONS);
      await frames(page, 4);
      expect(await inView(page, key)).toBe(true);
      expect(await isAtEnd(page)).toBe(false);
      await close(page);
    }, 30_000);
  }

  test("rows that grow above the view during a drag and its momentum never move what the reader sees", async () => {
    const page = await open();
    await dragBy(page, -1500);
    const watch = await page.evaluate(() => person.keyAt(300));
    const tail = await page.evaluate(
      ([watch, steps]) => {
        person.hold();
        person.touch("touchstart");
        return person.glide({ steps, watch, actions: { 3: [["growAbove", 100]], 5: [["release"]], 9: [["growAbove", 60]] } });
      },
      [watch, decelerate(16, 20).map((step) => -step)] as const,
    );
    expect(tail.writes).toEqual([]);
    expect(unexplained(tail.track)).toBeLessThanOrEqual(1);
    const before = await fromBottom(page, watch);
    await page.evaluate(() => person.end());
    await frames(page, 8);
    expect(Math.abs((await fromBottom(page, watch)) - before)).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);

  test("a row above the view that grows in the frame of the step that reveals it does not move the rows the reader saw", async () => {
    const page = await open();
    await dragBy(page, -1500);
    // The row at the top starts 20 px above the view, so the row above it ends there, whatever the fonts make of the
    // rows' heights.
    const align = await page.evaluate(() => {
      const row = document.querySelector(`[data-key="${person.keyAt(1)}"]`)!.getBoundingClientRect();
      return row.top - feed.viewport().getBoundingClientRect().top + 20;
    });
    await page.evaluate((dy) => person.drag([dy]), align);
    await page.waitForTimeout(300);
    const watch = await page.evaluate(() => person.keyAt(300));
    // The row above grows; the next step, in the same frame, reveals its last 20 px.
    const tail = await page.evaluate((watch) => {
      person.hold();
      person.touch("touchstart");
      return person.glide({ steps: [0, -40, -40, -40], watch, actions: { 1: [["growAbove", 100]] } });
    }, watch);
    expect(tail.writes).toEqual([]);
    expect(unexplained(tail.track)).toBeLessThanOrEqual(1);
    const before = await fromBottom(page, watch);
    await page.evaluate(() => {
      person.touch("touchend");
      person.end();
    });
    await frames(page, 8);
    expect(Math.abs((await fromBottom(page, watch)) - before)).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);

  test("ends a drag whose touched row left the document, so later changes are corrected at once again", async () => {
    const page = await open();
    await dragBy(page, -800);
    const key = await page.evaluate(() => person.keyAt(300));
    // Touch events keep going to the row where the touch began, also after the feed removed it.
    await page.evaluate(async (key) => {
      const row = document.querySelector(`[data-key="${key}"]`)!;
      await person.drag(
        Array.from({ length: 30 }, () => -100),
        row,
      );
    }, key);
    expect(await page.locator(`[data-key="${key}"]`).count()).toBe(0);
    await page.waitForTimeout(300);
    const watch = await page.evaluate(() => person.keyAt(300));
    await page.evaluate((watch) => {
      writes.length = 0;
      probe.start(watch);
      person.act("growAbove", 100);
    }, watch);
    await frames(page, 6);
    const run = await page.evaluate(() => probe.stop());
    expect(run.drift).toBeLessThanOrEqual(1);
    expect((await page.evaluate(() => writes)).length).toBeGreaterThan(0);
    await close(page);
  }, 30_000);

  test("sending while the list still coasts to older items shows the sent item at the end", async () => {
    const page = await open();
    await dragBy(page, -800);
    await page.evaluate(() => {
      person.hold();
      return person.drag([-50, -50]);
    });
    await page.evaluate(
      (steps) => {
        return person.glide({ steps, actions: { 4: [["send"], ["probe"]] } });
      },
      decelerate(20, 30).map((step) => -step),
    );
    await page.evaluate(() => person.end());
    await frames(page, 6);
    const run = await page.evaluate(() => probe.stop());
    // A step made in a frame callback reaches the feed with the next frame's scroll event, so each one shows for a
    // frame before the feed puts it back; it never adds up to coasting away from the end.
    expect(run.gapMin).toBeGreaterThanOrEqual(-32);
    expect(Math.abs(await endGap(page))).toBeLessThanOrEqual(1);
    expect(run.gapMax).toBeLessThanOrEqual(1);
    expect(await isAtEnd(page)).toBe(true);
    expect(await page.locator('[data-key="m300"]').count()).toBe(1);
    await close(page);
  }, 30_000);

  test("a slow momentum tail with long pauses between its scroll events writes nothing until the scroller ends it", async () => {
    const page = await open();
    await dragBy(page, -800);
    const watch = await page.evaluate(() => person.keyAt(300));
    const tail = await page.evaluate(async (watch) => {
      person.hold();
      await person.drag([-40, -40]);
      return person.glide({
        steps: [-6, -3, -2, -1, -1, -1],
        watch,
        actions: { 2: [["growAbove", 100]] },
        pause: { 1: 250, 2: 250, 3: 250, 4: 250, 5: 250 },
      });
    }, watch);
    expect(tail.writes).toEqual([]);
    expect(unexplained(tail.track)).toBeLessThanOrEqual(1);
    const before = await fromBottom(page, watch);
    await page.evaluate(() => person.end());
    await frames(page, 8);
    expect(Math.abs((await fromBottom(page, watch)) - before)).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);

  for (const [rows, scale, older] of [
    ["smaller", 1.2, 0],
    ["taller", 0.8, 0],
    ["smaller", 1.2, 500],
  ] as const) {
    test(`a fling to the start through rows ${rows} than estimated${older ? " that outruns the older page" : ""} shows no empty space above the first item, reaches it, and does not jump`, async () => {
      const page = await open({ count: 120, older, manual: true, estimateScale: scale });
      const start = await page.evaluate(async () => {
        const port = feed.viewport();
        person.hold();
        await person.drag([-80, -80, -80]);
        probe.start();
        // Momentum toward the start that runs until the scroll range ends there.
        for (let step = 0; step < 400 && port.scrollTop > 0; step++) {
          person.by(-Math.max(8, Math.round(140 * (1 - step / 160))));
          await new Promise(requestAnimationFrame);
        }
        await new Promise(requestAnimationFrame);
        const first = document.querySelector('.k2b-virtual-feed__item[data-index="0"] .row');
        return {
          head: probe.stop().head,
          top: port.scrollTop,
          first: first ? first.getBoundingClientRect().top - port.getBoundingClientRect().top : Number.NaN,
        };
      });
      expect(start.head).toBeLessThanOrEqual(1);
      expect(start.top).toBe(0);
      expect(Math.abs(start.first)).toBeLessThanOrEqual(1);
      const watch = await page.evaluate(() => person.keyAt(300));
      await page.evaluate((watch) => probe.start(watch), watch);
      if (older) {
        expect(await page.evaluate(() => feed.release())).toBe(1);
        await frames(page, 6);
      }
      await page.evaluate(() => person.end());
      // Longer than the longest wait for a scrollend, so the scroll has ended whichever way it ends.
      await page.waitForTimeout(1_200);
      expect((await page.evaluate(() => probe.stop())).drift).toBeLessThanOrEqual(1);
      await close(page);
    }, 30_000);
  }

  test("a reader who reached the end during a scroll and then moves up leaves the end, also after another item arrived", async () => {
    const page = await open();
    await dragBy(page, -800);
    // A finger holds the scroll; an item arrives on the way to the end, and the scroll reaches the end it had before.
    await page.evaluate(() => {
      person.hold();
      person.touch("touchstart");
      return person.glide({ toEnd: 30, actions: { 5: [["append", 1]] } });
    });
    expect(await isAtEnd(page)).toBe(true);
    await page.evaluate(() => feed.append(1));
    await frames(page, 4);
    expect(Math.abs(await endGap(page))).toBeLessThanOrEqual(1);
    const watch = await page.evaluate(() => person.keyAt(300));
    await page.evaluate(() => person.by(-30));
    await frames(page, 2);
    expect(await isAtEnd(page)).toBe(false);
    const before = await fromBottom(page, watch);
    await page.evaluate(() => {
      person.touch("touchend");
      person.end();
    });
    await frames(page, 8);
    expect(await isAtEnd(page)).toBe(false);
    expect(Math.abs((await fromBottom(page, watch)) - before)).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);

  test("a late scrollend while the finger rests does not end the scroll when the finger lifts into momentum", async () => {
    const page = await open();
    await dragBy(page, -1500);
    const watch = await page.evaluate(() => person.keyAt(300));
    // Two finger steps with a row growing above, a still frame with a scrollend that is not this scroll's end, then
    // the finger lifts and the momentum runs.
    const steps = [-60, -60, 0, ...decelerate(12, 30).map((step) => -step)];
    const tail = await page.evaluate(
      ([watch, steps]) => {
        person.hold();
        person.touch("touchstart");
        return person.glide({ steps, watch, actions: { 1: [["growAbove", 100]], 3: [["scrollend"], ["release"]] } });
      },
      [watch, steps] as const,
    );
    expect(tail.writes).toEqual([]);
    expect(unexplained(tail.track)).toBeLessThanOrEqual(1);
    const before = await fromBottom(page, watch);
    await page.evaluate(() => person.end());
    await frames(page, 8);
    expect(Math.abs((await fromBottom(page, watch)) - before)).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);

  test("the late scrollend of the feed's own write in a pause of a slow momentum tail does not end the scroll", async () => {
    const page = await open();
    // Following the end, the feed writes for a new item; the scrollend of that write arrives late, in the tail.
    await page.evaluate(() => {
      person.hold();
      feed.append(1);
    });
    await frames(page, 2);
    const watch = await page.evaluate(() => person.keyAt(300));
    const tail = await page.evaluate(async (watch) => {
      await person.drag([-40, -40]);
      // The tail stands still after its third step; the scrollend arrives in that pause.
      return person.glide({
        steps: [-6, -3, -2, 0, -1, -1, -1],
        watch,
        actions: { 2: [["growAbove", 100]], 4: [["scrollend"]] },
        pause: { 1: 120, 2: 120, 3: 120, 4: 120, 5: 120, 6: 120 },
      });
    }, watch);
    expect(tail.writes).toEqual([]);
    expect(unexplained(tail.track)).toBeLessThanOrEqual(1);
    const before = await fromBottom(page, watch);
    await page.evaluate(() => person.end());
    await frames(page, 8);
    expect(Math.abs((await fromBottom(page, watch)) - before)).toBeLessThanOrEqual(1);
    await close(page);
  }, 30_000);
});
