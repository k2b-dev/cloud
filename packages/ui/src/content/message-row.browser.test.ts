import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// Whether a row keeps its height, whether hover moves anything, and what a link really is are results of layout,
// paint, and the DOM in a real engine. The rows run inside VirtualFeed, as in a conversation.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// Fonts load from the build through a routed origin, so heights and screenshots use the real type and icons.
const assets = "http://k2b-ui.test/";
const fonts = ["plex.css", "tabler.css"]
  .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`))
  .join("\n");

const entry = resolve(import.meta.dir, "message-row.fixture.ts");
const fixtureSource = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { LocaleProvider, MessageRow, MessageSystemRow, VirtualFeed, startsMessageGroup } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const options = window.fixtureOptions ?? {};
const portrait =
  "data:image/svg+xml," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#c7d2fe"/><circle cx="32" cy="26" r="12" fill="#f1c7a5"/><rect x="12" y="42" width="40" height="22" rx="11" fill="#4f46e5"/></svg>');
const people = {
  nora: { name: "Nora Brandt" },
  tobias: { name: "Tobias Kern" },
  mara: { name: "Mara Feldmann", avatar: portrait },
  bot: { name: "Minutes", icon: "ti ti-robot" },
  me: { name: "Robin Example" },
};
const start = Date.UTC(2026, 9, 6, 9, 0);
const longText = Array.from({ length: 24 }, (_, index) => "Line " + (index + 1) + " of the release checklist with a few more words").join("\\n");
const unsafe = [
  '<img src=x onerror="window.hit = 1"> <script>window.hit = 2</script>',
  "[run](javascript:window.hit=3) <javascript:window.hit=4>",
  "[docs](https://example.com/docs) and [mail](mailto:team@example.com)",
].join("\\n\\n");
const code = "Here is the call:\\n\\n\`\`\`ts\\nconst response = await fetch('/api/meter-readings?from=2026-10-01&to=2026-10-31&include=history,corrections,annotations');\\n\`\`\`";
const [statuses, setStatuses] = createSignal({ m6: "pending", m7: "sent", m8: "failed", m14: "sent" });
const [receipts, setReceipts] = createSignal({});
const setReceipt = (text, id = "m7") => setReceipts((current) => ({ ...current, [id]: text }));
const [reactions, setReactions] = createSignal({});
const [threads, setThreads] = createSignal({});
const [texts, setTexts] = createSignal({});
const [progress, setProgress] = createSignal({});
window.retried = 0;
window.stopped = 0;
window.toggled = [];
window.quoted = 0;
window.opened = [];
const media = (name, width, height) => "http://k2b-ui.test/media/" + name + "-" + width + "x" + height + ".svg";
const basic = [
  { id: "m1", system: true, text: "Nora added Tobias", minute: 0 },
  { id: "m2", author: "nora", text: "Ich habe die Testfälle für die Anmeldung ergänzt.", minute: 1 },
  { id: "m3", author: "nora", text: "Der **Testplan** liegt im Wiki.", minute: 2 },
  { id: "m4", author: "tobias", text: code, minute: 4 },
  { id: "m5", author: "bot", text: "Summary since yesterday:\\n- Staging is up\\n- Tests pass", minute: 6, badge: true },
  { id: "m6", author: "me", own: true, text: "On my way.", minute: 7 },
  { id: "m7", author: "me", own: true, text: "Looks good to me.", minute: 7 },
  { id: "m8", author: "me", own: true, text: "Sending this one failed.", minute: 8 },
  { id: "m9", author: "mara", text: longText, minute: 20 },
  { id: "m10", author: "tobias", text: unsafe, minute: 21 },
];
// Quotes, reactions, threads, attachments, and the other states of rich content.
const rich = [
  {
    id: "m11",
    author: "nora",
    text: "Yes, **60 requests** per minute and account.",
    minute: 30,
    edited: true,
    quote: { author: "Tobias Kern", text: "The meter reading API is done. Is there a limit per minute? I would like to throttle the form before the release on Friday so nobody runs into errors." },
    reactions: [
      { key: "👍", emoji: "👍", count: 4, label: "Tobias, Mara, Robin, Minutes" },
      { key: "☕", emoji: "☕", count: 1, own: true, label: "Robin" },
    ],
    thread: { count: 3, participants: ["tobias", "mara"], lastReply: "10:42" },
  },
  {
    id: "m12",
    author: "tobias",
    text: "Here is the new tile grid:",
    minute: 32,
    attachments: [
      { kind: "image", src: media("grid", 1200, 800), alt: "Tile grid with six coloured tiles", width: 1200, height: 800, open: true },
      { kind: "file", name: "Testplan_Anmeldung_v3.pdf", detail: "PDF · 412 KB", mediaType: "application/pdf", href: "https://example.com/testplan.pdf" },
    ],
    reactions: [],
  },
  {
    id: "m13",
    author: "mara",
    text: "",
    minute: 34,
    attachments: [
      { kind: "image", src: media("one", 800, 1200), alt: "Portrait one", width: 800, height: 1200, open: true },
      { kind: "video", src: media("two", 1920, 1080), alt: "Walkthrough of the form", width: 1920, height: 1080, duration: "0:42", open: true },
      { kind: "image", src: media("three", 1000, 1000), alt: "Square three", width: 1000, height: 1000, open: true },
      { kind: "image", src: media("four", 1600, 900), alt: "Wide four", width: 1600, height: 900, open: true },
      { kind: "image", src: media("five", 900, 1600), alt: "Tall five", width: 900, height: 1600, open: true },
      { kind: "image", src: media("six", 900, 1600), alt: "Tall six", width: 900, height: 1600, open: true },
    ],
  },
  { id: "m14", author: "me", own: true, text: "Forwarding the release note.", minute: 40, forwarded: true, reactions: [] },
  { id: "m15", author: "bot", text: "", minute: 41, progress: "Writing", badge: true },
  { id: "m16", author: "tobias", text: "", minute: 42, deleted: true, thread: { count: 1, participants: ["nora"], lastReply: "11:02" } },
];
const messages = (options.messages ?? (options.rich ? rich : basic)).map((message) => ({ ...message, at: start + message.minute * 60_000 }));
// Items change either in place, through the signals above, or as new objects, which mounts a new row.
const [items, setItems] = createSignal(messages);
const replace = (id, patch) => setItems((list) => list.map((message) => (message.id === id ? { ...message, ...patch } : message)));
const entryOf = (message) => message && { author: message.author ?? "system", at: message.at, system: message.system };
const actions = [
  { id: "reply", label: options.locale === "de" ? "Antworten" : "Reply", icon: "ti ti-arrow-back-up", onSelect: () => (window.replied = (window.replied ?? 0) + 1) },
  { id: "react", label: options.locale === "de" ? "Reagieren" : "React", icon: "ti ti-mood-smile", onSelect: () => {} },
];
const time = (message) => new Date(message.at).toISOString().slice(11, 16);
const feed = () =>
  createComponent(VirtualFeed, {
    get items() {
      return items();
    },
    getKey: (message) => message.id,
    estimateSize: () => 64,
    label: "Conversation",
    itemLabel: (message) => (message.system ? undefined : people[message.author].name + ", " + time(message)),
    children: (message, position) =>
      message.system
        ? createComponent(MessageSystemRow, { icon: "ti ti-user-plus", time: time(message), children: message.text })
        : createComponent(MessageRow, {
            author: people[message.author],
            get text() {
              return texts()[message.id] ?? message.text;
            },
            time: time(message),
            dateTime: new Date(message.at),
            own: message.own,
            groupStart: startsMessageGroup(entryOf(message), entryOf(items()[position() - 1])),
            badge: message.badge ? "Agent" : undefined,
            get status() {
              return message.own ? (message.status ?? statuses()[message.id]) : undefined;
            },
            get receipt() {
              return receipts()[message.id];
            },
            onRetry: () => window.retried++,
            actions,
            quote: message.quote && { ...message.quote, onSelect: () => window.quoted++ },
            edited: message.edited,
            forwarded: message.forwarded,
            deleted: message.deleted,
            attachments: message.attachments?.map((attachment) =>
              attachment.open ? { ...attachment, onOpen: () => window.opened.push(attachment.alt) } : attachment,
            ),
            get reactions() {
              return reactions()[message.id] ?? message.reactions;
            },
            // As an application would: a new list of new objects for the message, changed in place.
            onToggleReaction: options.readOnly ? undefined : (key) => {
              window.toggled.push(message.id + " " + key);
              const current = reactions()[message.id] ?? message.reactions ?? [];
              setReactions({
                ...reactions(),
                [message.id]: current.map((reaction) =>
                  reaction.key === key ? { ...reaction, own: !reaction.own, count: reaction.count + (reaction.own ? -1 : 1) } : { ...reaction },
                ),
              });
            },
            onAddReaction: (anchor) => (window.addedFrom = anchor.getAttribute("aria-label")),
            get thread() {
              const thread = threads()[message.id] ?? message.thread;
              return (
                thread && {
                  ...thread,
                  participants: thread.participants.map((person) => people[person]),
                  onOpen: () => (window.threadOpened = message.id),
                }
              );
            },
            get progress() {
              const status = message.id in progress() ? progress()[message.id] : message.progress;
              return status ? { status, onStop: () => window.stopped++ } : undefined;
            },
          }),
  });
render(
  () => createComponent(LocaleProvider, { locale: options.locale ?? "en", get children() { return feed(); } }),
  document.getElementById("app"),
);
window.fixture = { setStatuses, setReceipt, replace, setReactions, setThreads, setTexts, setProgress };
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixtureSource },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the MessageRow fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type Theme = "light" | "dark";
type Message = {
  id: string;
  author: string;
  text: string;
  minute: number;
  own?: boolean;
  status?: string;
  reactions?: Reaction[];
  progress?: string;
  edited?: boolean;
  attachments?: object[];
  thread?: Thread;
  quote?: { author: string; text: string };
};
type Reaction = { key: string; emoji: string; count: number; own?: boolean; label?: string };
type Thread = { count: number; participants: string[]; lastReply?: string };
type Fixture = {
  setStatuses: (next: Record<string, string>) => void;
  /** Sets the read receipt of an own message, by default m7. */
  setReceipt: (text?: string, id?: string) => void;
  replace: (id: string, patch: Partial<Message>) => void;
  setReactions: (next: Record<string, Reaction[]>) => void;
  setThreads: (next: Record<string, Thread>) => void;
  /** Changes texts in place, as a message streams in. */
  setTexts: (next: Record<string, string>) => void;
  /** Changes the progress status in place; an empty status ends it. */
  setProgress: (next: Record<string, string | undefined>) => void;
};
type Recorded = { stopped: number; toggled: string[]; quoted: number; opened: string[]; addedFrom?: string; threadOpened?: string };
const recorded = (page: Page) =>
  page.evaluate(() => {
    const { stopped, toggled, quoted, opened, addedFrom, threadOpened } = window as unknown as Recorded;
    return { stopped, toggled, quoted, opened, addedFrom, threadOpened };
  });
declare const fixture: Fixture;
declare const retried: number;
declare const hit: number | undefined;
const replied = (page: Page) => page.evaluate(() => (window as unknown as { replied?: number }).replied ?? 0);

/** Pixel size of a test image from its URL, such as `/media/grid-1200x800.svg`. */
const mediaSize = (url: string) =>
  url
    .match(/-(\d+)x(\d+)\.svg$/)!
    .slice(1)
    .map(Number) as [number, number];

const open = async (
  options: {
    width?: number;
    theme?: Theme;
    locale?: "en" | "de";
    touch?: boolean;
    messages?: Message[];
    /** Shows the messages with quotes, reactions, threads, and attachments instead of the basic ones. */
    rich?: boolean;
    /** Shows reactions without `onToggleReaction`. */
    readOnly?: boolean;
    /** Holds every image response until the returned page's `releaseMedia()` runs. */
    holdMedia?: boolean;
  } = {},
): Promise<Page & { releaseMedia: () => void }> => {
  const width = options.width ?? 720;
  const page = await browser.newPage({
    viewport: { width, height: 1400 },
    ...(options.touch ? { hasTouch: true, isMobile: true } : {}),
  });
  page.on("dialog", (dialog) => void dialog.dismiss());
  await page.route(`${assets}**`, (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
  );
  // Images are drawn at their stored size, so a wrong reservation would show as a changed area once they arrive.
  let releaseMedia = () => {};
  const held = new Promise<void>((done) => {
    releaseMedia = done;
  });
  if (!options.holdMedia) releaseMedia();
  await page.route(`${assets}media/**`, async (route) => {
    const [width, height] = mediaSize(route.request().url());
    await held;
    await route.fulfill({
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#93c5fd"/><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 4}" fill="#1d4ed8"/></svg>`,
    });
  });
  await page.setContent(
    `<!doctype html><html lang="${options.locale ?? "en"}"><head><meta name="viewport" content="width=device-width">` +
      `<style>${css}</style><style>${fonts}</style>` +
      "<style>*,*::before,*::after{transition:none!important}</style></head>" +
      `<body class="k2b-ui${options.theme === "dark" ? " k2b-dark" : ""}" style="margin:0;background:var(--k2b-surface)">` +
      `<div id="app" style="display:flex;width:${width}px;height:1400px"></div></body></html>`,
  );
  // Fonts first: a font that arrives late changes every text's height, which is not the row's doing.
  await page.evaluate(async () => {
    await Promise.all(
      [
        "400 15px 'IBM Plex Sans'",
        "italic 400 15px 'IBM Plex Sans'",
        "500 15px 'IBM Plex Sans'",
        "600 15px 'IBM Plex Sans'",
        "700 15px 'IBM Plex Sans'",
        "400 13px 'IBM Plex Mono'",
        "16px tabler-icons",
      ].map((font) => document.fonts.load(font)),
    );
    (window as unknown as { preloaded: Set<FontFace> }).preloaded = new Set(
      Array.from(document.fonts).filter((face) => face.status === "loaded"),
    );
  });
  await page.evaluate(
    ([locale, messages, rich, readOnly]) => {
      (window as unknown as { fixtureOptions: object }).fixtureOptions = { locale, messages, rich, readOnly };
      // Record every row's height from the frame it mounts in; a later change would move the rows below it.
      const heights = new Map<string, number[]>();
      (window as unknown as { heights: typeof heights }).heights = heights;
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          // A replaced item's old row reports its removal as a height of 0.
          if (!entry.target.isConnected) continue;
          const key = (entry.target as HTMLElement).dataset.key!;
          heights.set(key, [...(heights.get(key) ?? []), entry.borderBoxSize[0]!.blockSize]);
        }
      });
      new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes) if (node instanceof HTMLElement && node.dataset.key) observer.observe(node);
      }).observe(document.getElementById("app")!, { childList: true, subtree: true });
    },
    [options.locale ?? "en", options.messages, options.rich, options.readOnly] as const,
  );
  await page.addScriptTag({ content: script });
  await page.locator(`[data-key="${options.messages?.at(-1)?.id ?? (options.rich ? "m16" : "m10")}"] .k2b-message-row`).waitFor();
  // Layout requests every face the rows use, so one missing from the list above shows here, not as a late shift.
  expect(
    await page.evaluate(() => {
      const { preloaded } = window as unknown as { preloaded: Set<FontFace> };
      return Array.from(document.fonts)
        .filter((face) => face.status !== "unloaded" && !preloaded.has(face))
        .map((face) => `${face.style} ${face.weight} ${face.family}`);
    }),
  ).toEqual([]);
  if (!options.touch) await page.mouse.move(width - 1, 1399);
  return Object.assign(page, { releaseMedia });
};

const rowOf = (page: Page, key: string) => page.locator(`[data-key="${key}"]`);

/** Every box inside the feed, so any movement shows. */
const boxes = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll(".k2b-virtual-feed__feed *"), (element) => {
      const box = element.getBoundingClientRect();
      return `${element.className || element.tagName} ${[box.x, box.y, box.width, box.height].map((value) => value.toFixed(2)).join(" ")}`;
    }),
  );

const opacity = (page: Page, key: string) =>
  rowOf(page, key).evaluate((row) => getComputedStyle(row.querySelector(".k2b-message-row__actions")!).opacity);

describe(`MessageRow in ${browserName}`, () => {
  test("hover and focus show the actions without moving anything", async () => {
    const page = await open();
    try {
      const before = await boxes(page);
      expect(await opacity(page, "m4")).toBe("0");

      await rowOf(page, "m4").locator(".k2b-message-row__bubble").hover();
      expect(await opacity(page, "m4")).toBe("1");
      expect(await boxes(page)).toEqual(before);
      await page.screenshot({ path: `/tmp/k2b-ui-message-rows-${browserName}-hover.png`, clip: { x: 0, y: 150, width: 720, height: 300 } });

      await page.mouse.move(719, 1399);
      await rowOf(page, "m6").focus();
      expect(await opacity(page, "m6")).toBe("1");
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.closest(".k2b-message-row__actions") !== null)).toBe(true);
      expect(await opacity(page, "m6")).toBe("1");
      expect(await boxes(page)).toEqual(before);

      await page.keyboard.press("Enter");
      expect(await replied(page)).toBe(1);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a tap where the hidden actions sit runs none of them; it focuses the message and shows them", async () => {
    const page = await open({ width: 390, touch: true });
    try {
      const reply = rowOf(page, "m4").getByRole("button", { name: "Reply" });
      const box = (await reply.boundingBox())!;
      const center = [box.x + box.width / 2, box.y + box.height / 2] as const;
      expect(await opacity(page, "m4")).toBe("0");

      await page.touchscreen.tap(...center);
      expect(await replied(page)).toBe(0);
      expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key)).toBe("m4");
      expect(await opacity(page, "m4")).toBe("1");

      await page.touchscreen.tap(...center);
      expect(await replied(page)).toBe(1);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a collapsed message opens when focus reaches its hidden or faded part and never scrolls inside", async () => {
    const lines = (count: number, links: Record<number, string>) =>
      Array.from({ length: count }, (_, index) =>
        links[index + 1]
          ? `Line ${index + 1} with [${links[index + 1]}](https://example.com/${links[index + 1]})`
          : `Line ${index + 1} of the checklist`,
      ).join("\n");
    const page = await open({
      messages: [
        { id: "c1", author: "nora", text: lines(20, { 2: "early", 18: "late" }), minute: 1 },
        { id: "c2", author: "tobias", text: lines(16, { 10: "faded" }), minute: 2 },
      ],
    });
    try {
      const state = (key: string) =>
        rowOf(page, key).evaluate((row) => {
          const text = row.querySelector<HTMLElement>(".k2b-message-row__text")!;
          const focused = document.activeElement!.getBoundingClientRect();
          const box = text.getBoundingClientRect();
          return {
            focused: document.activeElement!.textContent,
            collapsed: text.hasAttribute("data-collapsed"),
            scrollTop: text.scrollTop,
            visible: focused.top >= box.top && focused.bottom <= box.bottom,
          };
        });

      await rowOf(page, "c1").focus();
      await page.keyboard.press("Tab");
      expect(await state("c1")).toEqual({ focused: "early", collapsed: true, scrollTop: 0, visible: true });
      await page.keyboard.press("Tab");
      expect(await state("c1")).toEqual({ focused: "late", collapsed: false, scrollTop: 0, visible: true });

      await rowOf(page, "c2").focus();
      await page.keyboard.press("Tab");
      expect(await state("c2")).toEqual({ focused: "faded", collapsed: false, scrollTop: 0, visible: true });
    } finally {
      await page.close();
    }
  }, 30_000);

  test("collapses exactly the messages whose rendered text is taller than the clamp", async () => {
    const page = await open({
      messages: [
        { id: "k1", author: "nora", text: `[docs](https://example.com/${"x".repeat(1500)})`, minute: 1 },
        { id: "k2", author: "tobias", text: `\`\`\`\n${Array.from({ length: 5 }, () => "log ".repeat(75)).join("\n")}\n\`\`\``, minute: 2 },
        {
          id: "k3",
          author: "nora",
          text: Array.from({ length: 8 }, (_, index) => `- [Link ${index + 1}](https://example.com/${"y".repeat(220)})`).join("\n"),
          minute: 3,
        },
        {
          id: "k4",
          author: "tobias",
          text: `Short text\n\n${Array.from({ length: 14 }, (_, index) => `[r${index}]: https://example.com/${index}`).join("\n")}`,
          minute: 4,
        },
        {
          id: "k5",
          author: "nora",
          text: `\`\`\`\n${Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n\n")}\n\`\`\``,
          minute: 5,
        },
        {
          id: "k6",
          author: "tobias",
          text: Array.from({ length: 24 }, (_, index) => `Line ${index + 1} of the release checklist`).join("\n"),
          minute: 6,
        },
      ],
    });
    try {
      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>(".k2b-virtual-feed__item"), (row) => {
          const text = row.querySelector<HTMLElement>(".k2b-message-row__text")!;
          const line = Number.parseFloat(getComputedStyle(text).lineHeight);
          const content = text.lastElementChild!.getBoundingClientRect().bottom;
          return {
            key: row.dataset.key,
            collapsed: text.hasAttribute("data-collapsed"),
            hiddenLines: Math.round((content - text.getBoundingClientRect().bottom) / line),
            more: row.querySelector(".k2b-message-row__more") !== null,
          };
        }),
      );
      expect(rows.map(({ key, collapsed, more }) => ({ key, collapsed, more }))).toEqual([
        { key: "k1", collapsed: false, more: false },
        { key: "k2", collapsed: false, more: false },
        { key: "k3", collapsed: false, more: false },
        { key: "k4", collapsed: false, more: false },
        { key: "k5", collapsed: true, more: true },
        { key: "k6", collapsed: true, more: true },
      ]);
      for (const row of rows) if (row.collapsed) expect(row.hiddenLines, row.key).toBeGreaterThanOrEqual(2);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a replaced item keeps its row's height and focus, and the row announces nothing", async () => {
    const page = await open();
    try {
      await rowOf(page, "m6").focus();
      await page.evaluate(() => fixture.replace("m6", { status: "failed" }));
      await page.evaluate(() => fixture.setStatuses({ m6: "pending", m7: "failed", m8: "failed" }));
      await page.waitForTimeout(400);

      expect((await rowOf(page, "m6").locator(".k2b-message-row__line").innerText()).replace(/\s+/g, " ")).toBe("Not sent Retry");
      expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key)).toBe("m6");
      const heights = await page.evaluate(() => Object.fromEntries((window as unknown as { heights: Map<string, number[]> }).heights));
      for (const [key, sizes] of Object.entries(heights)) expect(new Set(sizes).size, `${key}: ${sizes.join(", ")}`).toBe(1);
      // The application announces a failed send where it learns of it; a row may not even be mounted then.
      expect(await page.evaluate(() => document.querySelector("[data-k2b-live]")?.textContent ?? "")).not.toContain("Not sent");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a long code language never pushes Copy out of the block on a narrow phone", async () => {
    const page = await open({
      width: 320,
      locale: "de",
      messages: [{ id: "x1", author: "nora", text: "\`\`\`WWWWWWWWWWWWWWWWWWWWWWWW\nconst a = 1;\n\`\`\`", minute: 1 }],
    });
    try {
      const layout = await rowOf(page, "x1").evaluate((row) => {
        const block = row.querySelector(".k2b-message-row__code")!.getBoundingClientRect();
        const copy = row.querySelector(".k2b-message-row__copy")!.getBoundingClientRect();
        const label = row.querySelector<HTMLElement>(".k2b-message-row__code-label")!;
        return { inside: copy.right <= block.right && copy.left >= block.left, truncated: label.scrollWidth > label.clientWidth };
      });
      expect(layout).toEqual({ inside: true, truncated: true });
    } finally {
      await page.close();
    }
  }, 30_000);

  test("rows keep the height they mount with while sends complete, fail, and get read", async () => {
    const page = await open();
    try {
      await page.evaluate(() => {
        fixture.setStatuses({ m6: "sent", m7: "sent", m8: "pending" });
        fixture.setReceipt(`Read by ${Array.from({ length: 12 }, (_, index) => `Reader ${index + 1}`).join(", ")}`);
      });
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      await page.evaluate(() => fixture.setStatuses({ m6: "failed", m7: "sent", m8: "sent" }));
      await page.waitForTimeout(400);

      const heights = await page.evaluate(() => Object.fromEntries((window as unknown as { heights: Map<string, number[]> }).heights));
      expect(Object.keys(heights).sort()).toEqual(["m1", "m10", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]);
      for (const [key, sizes] of Object.entries(heights)) expect(new Set(sizes).size, `${key}: ${sizes.join(", ")}`).toBe(1);
      // A long receipt ends in an ellipsis within its one line.
      expect(
        await rowOf(page, "m7")
          .locator(".k2b-message-row__receipt")
          .evaluate((text) => text.scrollHeight > text.clientHeight),
      ).toBe(true);

      await rowOf(page, "m6").getByRole("button", { name: "Retry" }).click();
      expect(await page.evaluate(() => retried)).toBe(1);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a long message mounts collapsed and opens only when asked", async () => {
    const page = await open();
    try {
      const row = rowOf(page, "m9");
      const text = row.locator(".k2b-message-row__text");
      const clamp = await text.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        hidden: element.scrollHeight - element.clientHeight,
        line: Number.parseFloat(getComputedStyle(element).lineHeight),
      }));
      expect(clamp.height).toBeCloseTo(clamp.line * 10, 0);
      expect(clamp.hidden).toBeGreaterThan(clamp.line * 4);

      const more = row.getByRole("button", { name: "Show more" });
      expect(await more.getAttribute("aria-expanded")).toBe("false");
      await more.click();
      expect(await row.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
      expect(await text.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a collapsed message keeps a Markdown table's reach past the text, and opening it moves nothing", async () => {
    const table = "| Name | Count |\n| --- | --: |\n| Apples | 3 |\n| Pears | 5 |";
    const lines = Array.from({ length: 16 }, (_, index) => `Line ${index + 1} of the checklist`).join("\n");
    const page = await open({ messages: [{ id: "t1", author: "nora", text: `Before the table\n\n${table}\n\n${lines}`, minute: 1 }] });
    try {
      const row = rowOf(page, "t1");
      const measure = () =>
        row.evaluate((row) => {
          const text = row.querySelector<HTMLElement>(".k2b-message-row__text")!;
          const wrap = text.querySelector(".k2b-content-markdown__table")!.getBoundingClientRect();
          const first = text.querySelector("p")!.getBoundingClientRect();
          const left = text.getBoundingClientRect().left + text.clientLeft;
          return {
            collapsed: text.hasAttribute("data-collapsed"),
            // The clamp clips: the table's lines reach past the text inside it.
            inside: wrap.left >= left - 0.5 && wrap.right <= left + text.clientWidth + 0.5,
            boxes: [first, wrap].map((box) => [box.left, box.top, box.width].map((value) => value.toFixed(2))),
          };
        });
      const collapsed = await measure();
      expect({ collapsed: collapsed.collapsed, inside: collapsed.inside }).toEqual({ collapsed: true, inside: true });
      await row.getByRole("button", { name: "Show more" }).click();
      const opened = await measure();
      expect(opened.collapsed).toBe(false);
      // The text and the table keep their place and width.
      expect(opened.boxes).toEqual(collapsed.boxes);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("raw HTML and javascript: links stay text, and links open apart from the page", async () => {
    const page = await open();
    try {
      const text = rowOf(page, "m10").locator(".k2b-message-row__text");
      const result = await text.evaluate((element) => ({
        content: element.textContent,
        elements: Array.from(element.querySelectorAll("img, script, iframe, [onerror]"), (node) => node.tagName),
        links: Array.from(element.querySelectorAll("a"), (link) => ({
          href: link.getAttribute("href"),
          target: link.target,
          rel: link.rel,
        })),
      }));
      await page.waitForTimeout(200);

      expect(result.elements).toEqual([]);
      expect(result.content).toContain('<img src=x onerror="window.hit = 1">');
      expect(result.content).toContain("<script>window.hit = 2</script>");
      expect(result.content).toContain("run javascript:window.hit=4");
      expect(result.links).toEqual([
        { href: "https://example.com/docs", target: "_blank", rel: "noopener noreferrer" },
        { href: "mailto:team@example.com", target: "_blank", rel: "noopener noreferrer" },
      ]);
      expect(await page.evaluate(() => typeof hit)).toBe("undefined");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a code block scrolls inside the message and copies without changing size", async () => {
    const page = await open({ width: 390 });
    try {
      const row = rowOf(page, "m4");
      const layout = await row.evaluate((element) => {
        const pre = element.querySelector("pre")!;
        const bubble = element.querySelector(".k2b-message-row__bubble")!.getBoundingClientRect();
        return {
          scrolls: pre.scrollWidth > pre.clientWidth,
          inside: bubble.right <= element.getBoundingClientRect().right,
          page: document.querySelector(".k2b-virtual-feed__viewport")!.scrollWidth <= 390,
        };
      });
      expect(layout).toEqual({ scrolls: true, inside: true, page: true });

      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (text: string) => {
              (window as unknown as { copied: string }).copied = text;
            },
          },
        });
      });
      const copy = row.locator(".k2b-message-row__copy");
      const before = await copy.boundingBox();
      await copy.click();
      await page.waitForFunction(() => document.querySelector(".k2b-message-row__copy[data-copied]") !== null);
      expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toStartWith("const response = await fetch(");
      expect(await copy.boundingBox()).toEqual(before);
      expect((await copy.innerText()).trim()).toBe("Copied");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("images and videos reserve their area from the stored size, so nothing moves while they load", async () => {
    const page = await open({ rich: true, holdMedia: true });
    try {
      // The progress spinner turns; only what the images could move counts.
      await page.emulateMedia({ reducedMotion: "reduce" });
      const areas = () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>(".k2b-message-row__media-item"), (item) => {
            const box = item.getBoundingClientRect();
            return { width: Math.round(box.width * 100) / 100, height: Math.round(box.height * 100) / 100 };
          }),
        );
      const before = await boxes(page);
      const reserved = await areas();
      expect(
        await page.evaluate(() =>
          Array.from(document.images)
            .filter((image) => image.closest(".k2b-message-row__media"))
            .some((image) => image.complete && image.naturalWidth > 0),
        ),
      ).toBe(false);
      // One image keeps its 3:2 shape, at most as tall as the media height; a grid shows four squares and the rest as "+2".
      expect(reserved[0]!.width / reserved[0]!.height).toBeCloseTo(1.5, 2);
      expect(reserved[0]!.height).toBeLessThanOrEqual(320);
      for (const cell of reserved.slice(1)) expect(cell.width).toBeCloseTo(cell.height, 1);
      expect(reserved).toHaveLength(5);
      expect((await rowOf(page, "m13").locator(".k2b-message-row__media-more").innerText()).trim()).toBe("+2");

      page.releaseMedia();
      await page.waitForFunction(() =>
        Array.from(document.images)
          .filter((image) => image.closest(".k2b-message-row__media"))
          .every((image) => image.complete && image.naturalWidth > 0),
      );
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      expect(await areas()).toEqual(reserved);
      expect(await boxes(page)).toEqual(before);
      const heights = await page.evaluate(() => Object.fromEntries((window as unknown as { heights: Map<string, number[]> }).heights));
      for (const [key, sizes] of Object.entries(heights)) expect(new Set(sizes).size, `${key}: ${sizes.join(", ")}`).toBe(1);
      await page.screenshot({ path: `/tmp/k2b-ui-message-rows-${browserName}-media.png` });
    } finally {
      await page.close();
    }
  }, 30_000);

  test("attachments name themselves and open as the caller decides", async () => {
    const page = await open({ rich: true });
    try {
      const grid = rowOf(page, "m13").getByRole("group", { name: "Attachments" });
      await grid.getByRole("button", { name: "Walkthrough of the form, Video 0:42", exact: true }).click();
      await grid.getByRole("button", { name: "Wide four, 2 more", exact: true }).click();
      await rowOf(page, "m12").getByRole("button", { name: "Tile grid with six coloured tiles" }).click();
      expect((await recorded(page)).opened).toEqual(["Walkthrough of the form", "Wide four", "Tile grid with six coloured tiles"]);

      const file = rowOf(page, "m12").getByRole("link", { name: "Testplan_Anmeldung_v3.pdf PDF · 412 KB" });
      expect(await file.evaluate((link: HTMLAnchorElement) => ({ href: link.href, target: link.target, rel: link.rel }))).toEqual({
        href: "https://example.com/testplan.pdf",
        target: "_blank",
        rel: "noopener noreferrer",
      });
      expect(await file.locator("i").getAttribute("class")).toBe("ti ti-file-type-pdf");
      // A message of images alone has no empty bubble.
      expect(await rowOf(page, "m13").locator(".k2b-message-row__bubble").count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("reactions come and go without moving any row", async () => {
    const page = await open({ rich: true, width: 390 });
    try {
      const rows = () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>(".k2b-virtual-feed__item"), (row) => {
            const box = row.getBoundingClientRect();
            return `${row.dataset.key} ${box.top.toFixed(2)} ${box.height.toFixed(2)}`;
          }),
        );
      const settle = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      const before = await rows();
      const many = Array.from("😀😃😄😁😆😅🤣😂🙂🙃😉😊", (emoji, index) => ({ key: emoji, emoji, count: index + 1 }));

      // The first reaction on a reserved bar, many more than fit, and the last one going away.
      await page.evaluate(
        ([many]) => fixture.setReactions({ m14: [{ key: "👍", emoji: "👍", count: 1, own: true }], m12: many, m11: [] }),
        [many] as const,
      );
      await settle();
      expect(await rows()).toEqual(before);
      expect(await rowOf(page, "m14").getByRole("button", { name: "👍 1 reaction" }).getAttribute("aria-pressed")).toBe("true");
      expect(
        await rowOf(page, "m12")
          .locator(".k2b-message-row__reaction-list")
          .evaluate((list) => list.scrollWidth > list.clientWidth),
      ).toBe(true);
      expect(await rowOf(page, "m11").locator(".k2b-message-row__reaction").count()).toBe(0);

      await page.evaluate(() => fixture.setReactions({}));
      await settle();
      expect(await rows()).toEqual(before);
      const heights = await page.evaluate(() => Object.fromEntries((window as unknown as { heights: Map<string, number[]> }).heights));
      for (const [key, sizes] of Object.entries(heights)) expect(new Set(sizes).size, `${key}: ${sizes.join(", ")}`).toBe(1);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("quote, reactions, and thread work from the keyboard and name themselves", async () => {
    const page = await open({ rich: true });
    try {
      const reactions = rowOf(page, "m11").getByRole("group", { name: "Reactions" });
      expect(
        await reactions.getByRole("button", { name: "👍 4 reactions: Tobias, Mara, Robin, Minutes" }).getAttribute("aria-pressed"),
      ).toBe("false");
      expect(await reactions.getByRole("button", { name: "☕ 1 reaction: Robin" }).getAttribute("aria-pressed")).toBe("true");

      await rowOf(page, "m11").focus();
      const order: string[] = [];
      for (let step = 0; step < 7; step++) {
        await page.keyboard.press("Tab");
        order.push(
          await page.evaluate(() => {
            const active = document.activeElement as HTMLElement;
            return active.getAttribute("aria-label") ?? active.className;
          }),
        );
      }
      expect(order).toEqual([
        "k2b-message-row__quote",
        "k2b-message-row__thread",
        "👍 4 reactions: Tobias, Mara, Robin, Minutes",
        "☕ 1 reaction: Robin",
        "Add reaction",
        "Reply",
        "React",
      ]);

      await rowOf(page, "m11").locator(".k2b-message-row__quote").focus();
      await page.keyboard.press("Enter");
      await reactions.getByRole("button", { name: "👍 4 reactions: Tobias, Mara, Robin, Minutes" }).focus();
      await page.keyboard.press("Enter");
      await reactions.getByRole("button", { name: "Add reaction" }).focus();
      await page.keyboard.press("Space");
      await rowOf(page, "m11").getByRole("button", { name: "3 replies Last reply 10:42" }).focus();
      await page.keyboard.press("Enter");
      expect(await recorded(page)).toMatchObject({ quoted: 1, toggled: ["m11 👍"], addedFrom: "Add reaction", threadOpened: "m11" });

      // The quote reads as a reply to its author for screen readers.
      expect(
        await rowOf(page, "m11")
          .getByRole("button", { name: /^In reply to Tobias Kern The meter reading API/ })
          .count(),
      ).toBe(1);

      // An empty, reserved bar shows "Add reaction" only while the message is hovered or focused.
      const add = rowOf(page, "m14").getByRole("button", { name: "Add reaction" });
      expect(await add.evaluate((button) => getComputedStyle(button).opacity)).toBe("0");
      await rowOf(page, "m14").focus();
      expect(await add.evaluate((button) => getComputedStyle(button).opacity)).toBe("1");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a reaction chip keeps its element and focus while it toggles and others come and go", async () => {
    const page = await open({ rich: true });
    try {
      const chip = rowOf(page, "m11").getByRole("button", { name: /^👍/ });
      await chip.focus();
      await chip.evaluate((element) => {
        (element as HTMLElement).dataset.probe = "";
      });
      const focused = () =>
        page.evaluate(() => {
          const active = document.activeElement as HTMLElement;
          return {
            same: active.dataset.probe === "",
            pressed: active.getAttribute("aria-pressed"),
            label: active.getAttribute("aria-label"),
          };
        });

      // The fixture answers each press with a new list of new objects, as an application would.
      await page.keyboard.press("Enter");
      expect(await focused()).toEqual({ same: true, pressed: "true", label: "👍 5 reactions: Tobias, Mara, Robin, Minutes" });
      await page.keyboard.press("Space");
      expect(await focused()).toEqual({ same: true, pressed: "false", label: "👍 4 reactions: Tobias, Mara, Robin, Minutes" });
      await page.evaluate(() =>
        fixture.setReactions({
          m11: [
            { key: "👍", emoji: "👍", count: 4, label: "Tobias, Mara, Robin, Minutes" },
            { key: "🎉", emoji: "🎉", count: 1, label: "Nora" },
          ],
        }),
      );
      expect(await focused()).toMatchObject({ same: true, pressed: "false" });
      expect(await rowOf(page, "m11").locator(".k2b-message-row__reaction").count()).toBe(2);
      expect((await recorded(page)).toggled).toEqual(["m11 👍", "m11 👍"]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("Stop keeps focus while the message streams in place", async () => {
    const page = await open({ rich: true });
    try {
      const stop = rowOf(page, "m15").getByRole("button", { name: "Stop" });
      await stop.focus();
      await stop.evaluate((element) => {
        (element as HTMLElement).dataset.probe = "";
      });
      const words = "Here is what changed since this morning: the meter reading API is live with a limit of 60 requests".split(" ");
      for (let count = 1; count <= words.length; count++) {
        await page.evaluate((text) => fixture.setTexts({ m15: text }), words.slice(0, count).join(" "));
        if (count === 5) await page.evaluate(() => fixture.setProgress({ m15: "Searching the files" }));
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
        expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.probe), `after ${count} words`).toBe("");
      }
      expect(await rowOf(page, "m15").locator(".k2b-message-row__text").innerText()).toEndWith("60 requests");
      expect(await rowOf(page, "m15").locator(".k2b-message-row__bubble").getAttribute("aria-busy")).toBe("true");

      await page.keyboard.press("Enter");
      expect((await recorded(page)).stopped).toBe(1);
    } finally {
      await page.close();
    }
  }, 30_000);

  for (const locale of ["en", "de"] as const)
    test(`the send state, progress, and their buttons stay whole beside many reactions on a narrow phone (${locale})`, async () => {
      const many = Array.from("😀😃😄😁😆😅🤣😂🙂🙃😉😊", (emoji, index) => ({ key: emoji, emoji, count: index + 1 }));
      const page = await open({
        width: 320,
        locale,
        messages: [
          { id: "n1", author: "me", own: true, text: "This one failed.", minute: 1, status: "failed", reactions: many },
          { id: "n2", author: "me", own: true, text: "Pending.", minute: 2, status: "pending", reactions: many },
          { id: "n3", author: "me", own: true, text: "Read.", minute: 3, status: "sent", reactions: many.slice(0, 6) },
          { id: "n4", author: "bot", text: "", minute: 4, progress: "Searching the files in the archive", reactions: many },
        ],
      });
      try {
        await page.evaluate(() => fixture.setReceipt("Read by Nora Brandt, Tobias Kern and Mara Feldmann", "n3"));
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        const layout = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>(".k2b-virtual-feed__item"), (item) => {
            const row = item.querySelector(".k2b-message-row")!.getBoundingClientRect();
            const line = item.querySelector(".k2b-message-row__line")!;
            const list = item.querySelector<HTMLElement>(".k2b-message-row__reaction-list")!;
            const add = item.querySelector(".k2b-message-row__react")!.getBoundingClientRect();
            const text = line.querySelector(".k2b-message-row__receipt, .k2b-message-row__line-text");
            return {
              key: item.dataset.key,
              // Every part of the line lies inside the row, after "Add reaction", and words other than the receipt or
              // progress are whole.
              inside: Array.from(line.children).every((child) => {
                const box = child.getBoundingClientRect();
                return box.left >= add.right && box.right <= row.right;
              }),
              whole: Array.from(
                line.querySelectorAll("span:not(.k2b-message-row__receipt, .k2b-message-row__line-text, .k2b-sr-only)"),
              ).every((span) => span.scrollWidth <= span.clientWidth),
              text: text ? Math.round(text.getBoundingClientRect().width) : undefined,
              chips: Math.round(list.getBoundingClientRect().width),
              fade: list.getAttribute("data-scroll-fade"),
            };
          }),
        );
        for (const row of layout) {
          expect(row.inside, row.key).toBe(true);
          expect(row.whole, row.key).toBe(true);
          // Beside a receipt or progress, the chips keep room for at least one, and a fade says that more follow. A
          // message that is not sent yet has no one's reactions, so there the chips may give way entirely.
          if (row.text === undefined) continue;
          expect(row.chips, row.key).toBeGreaterThanOrEqual(36);
          expect(row.fade, row.key).toBe("bottom");
          // The receipt and the progress keep at least a word.
          expect(row.text, row.key).toBeGreaterThanOrEqual(24);
        }
        await rowOf(page, "n1")
          .getByRole("button", { name: locale === "de" ? "Erneut senden" : "Retry" })
          .click();
        await rowOf(page, "n4")
          .getByRole("button", { name: locale === "de" ? "Stoppen" : "Stop" })
          .click();
        expect(await page.evaluate(() => retried)).toBe(1);
        expect((await recorded(page)).stopped).toBe(1);
        await page.screenshot({ path: `/tmp/k2b-ui-message-rows-${browserName}-narrow-footer-${locale}.png` });
      } finally {
        await page.close();
      }
    }, 30_000);

  test("read-only reactions say which are the reader's own, and their list scrolls from the keyboard", async () => {
    const many = Array.from("😀😃😄😁😆😅🤣😂🙂🙃😉😊", (emoji, index) => ({ key: emoji, emoji, count: index + 1 }));
    const page = await open({
      width: 390,
      readOnly: true,
      messages: [
        {
          id: "r1",
          author: "nora",
          text: "Lunch?",
          minute: 1,
          reactions: [{ key: "☕", emoji: "☕", count: 1, own: true, label: "Robin" }, ...many],
        },
      ],
    });
    try {
      const reactions = rowOf(page, "r1").getByRole("group", { name: "Reactions" });
      expect(await reactions.getByRole("img", { name: "☕ your reaction: Robin" }).count()).toBe(1);
      expect(await reactions.getByRole("img", { name: "😀 1 reaction" }).count()).toBe(1);
      expect(await rowOf(page, "r1").locator("button.k2b-message-row__reaction").count()).toBe(0);

      const list = rowOf(page, "r1").locator(".k2b-message-row__reaction-list");
      await rowOf(page, "r1").focus();
      await page.keyboard.press("Tab");
      expect(await list.evaluate((element) => element === document.activeElement)).toBe(true);
      // Arrow keys scroll the focused list; WebKit animates each step.
      expect(await list.getAttribute("data-scroll-fade")).toBe("bottom");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => document.querySelector(".k2b-message-row__reaction-list")!.scrollLeft >= 24);
      await page.waitForFunction(
        () => document.querySelector(".k2b-message-row__reaction-list")!.getAttribute("data-scroll-fade") === "both",
      );
    } finally {
      await page.close();
    }
  }, 30_000);

  test("on a touch screen the quote, thread bar, and reaction chips take taps in a 44 px area without taking others'", async () => {
    const page = await open({
      width: 390,
      touch: true,
      messages: [
        {
          id: "t1",
          author: "nora",
          text: "The plan:",
          minute: 1,
          attachments: [{ kind: "file", name: "Plan.pdf", alt: "Plan.pdf", open: true }],
          thread: { count: 2, participants: ["tobias"], lastReply: "10:42" },
        },
        { id: "t2", author: "tobias", text: "Looks good.", minute: 3, reactions: [{ key: "👍", emoji: "👍", count: 2 }] },
        { id: "t3", author: "tobias", text: "Which one?", minute: 4, quote: { author: "Nora Brandt", text: "The plan:" } },
        { id: "t4", author: "me", own: true, text: "Sending this one failed.", minute: 5, status: "failed" },
      ],
    });
    try {
      const box = async (key: string, selector: string) => (await rowOf(page, key).locator(selector).first().boundingBox())!;
      const tap = (x: number, y: number) => page.touchscreen.tap(x, y);
      const reach = (height: number) => (44 - height) / 2;

      const thread = await box("t1", ".k2b-message-row__thread");
      const center = thread.x + Math.min(thread.width, 120) / 2;
      await tap(center, thread.y - reach(thread.height) + 1);
      expect((await recorded(page)).threadOpened).toBe("t1");
      await page.evaluate(() => delete (window as { threadOpened?: string }).threadOpened);
      await tap(center, thread.y + thread.height + reach(thread.height) - 1);
      expect((await recorded(page)).threadOpened).toBe("t1");
      await page.evaluate(() => delete (window as { threadOpened?: string }).threadOpened);
      // The file chip above keeps its last pixel row.
      const file = await box("t1", ".k2b-message-row__file");
      await tap(file.x + 20, file.y + file.height - 1);
      expect(await recorded(page)).toMatchObject({ opened: ["Plan.pdf"], threadOpened: undefined });

      const chip = await box("t2", ".k2b-message-row__reaction");
      await tap(chip.x + chip.width / 2, chip.y - reach(chip.height) + 1);
      await tap(chip.x + chip.width / 2, chip.y + chip.height + reach(chip.height) - 1);
      expect((await recorded(page)).toggled).toEqual(["t2 👍", "t2 👍"]);

      // A quote that opens a continuation reaches up without taking the reactions of the row before.
      const quote = await box("t3", ".k2b-message-row__quote");
      await tap(quote.x + 40, quote.y - reach(quote.height) + 1);
      await tap(quote.x + 40, quote.y + quote.height + reach(quote.height) - 1);
      expect((await recorded(page)).quoted).toBe(2);
      expect((await recorded(page)).toggled).toHaveLength(2);

      const retry = await box("t4", ".k2b-message-row__line .k2b-button");
      await tap(retry.x + retry.width / 2, retry.y + retry.height + reach(retry.height) - 1);
      expect(await page.evaluate(() => retried)).toBe(1);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("the thread bar, the read line, and the footer keep a fixed height whatever they show", async () => {
    const page = await open({ width: 320, locale: "de", rich: true });
    try {
      const heights = (selector: string) =>
        page.evaluate(
          (selector) => Array.from(document.querySelectorAll(selector), (element) => element.getBoundingClientRect().height),
          selector,
        );
      const settle = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      expect(await heights(".k2b-message-row__thread")).toEqual([28, 28]);
      expect(new Set(await heights(".k2b-message-row__line"))).toEqual(new Set([20]));
      const footers = await heights(".k2b-message-row__footer");
      expect((await rowOf(page, "m15").locator(".k2b-message-row__line").innerText()).replace(/\s+/g, " ")).toBe("Writing Stoppen");

      await page.evaluate(() =>
        fixture.setThreads({
          m11: { count: 128, participants: ["tobias", "mara", "nora", "bot", "me"], lastReply: "gestern um 23:59 Uhr" },
          m16: { count: 2, participants: [], lastReply: undefined },
        }),
      );
      // The own message with its reserved reactions goes through every send state and gets read; the agent changes its step.
      for (const step of [
        { statuses: { m14: "pending" }, progress: { m15: "Durchsucht die Dateien im Archiv der Abteilung" } },
        { statuses: { m14: "failed" } },
        { statuses: { m14: "sent" }, receipt: "Gelesen von Nora Brandt, Tobias Kern und Mara Feldmann" },
      ]) {
        await page.evaluate((step) => {
          fixture.setStatuses(step.statuses);
          if (step.progress) fixture.setProgress(step.progress);
          if (step.receipt) fixture.setReceipt(step.receipt, "m14");
        }, step);
        await settle();
        expect(await heights(".k2b-message-row__thread"), JSON.stringify(step)).toEqual([28, 28]);
        expect(new Set(await heights(".k2b-message-row__line")), JSON.stringify(step)).toEqual(new Set([20]));
        expect(await heights(".k2b-message-row__footer"), JSON.stringify(step)).toEqual(footers);
        expect(
          await rowOf(page, "m14")
            .locator(".k2b-message-row__line")
            .evaluate((line) => line.getBoundingClientRect().right <= line.closest(".k2b-message-row")!.getBoundingClientRect().right),
        ).toBe(true);
        if (step.statuses.m14 === "failed")
          expect((await rowOf(page, "m14").locator(".k2b-message-row__line").innerText()).replace(/\s+/g, " ")).toBe(
            "Nicht gesendet Erneut senden",
          );
      }

      const thread = rowOf(page, "m11").locator(".k2b-message-row__thread");
      expect(await thread.locator(".k2b-avatar").count()).toBe(3);
      expect(
        await rowOf(page, "m11").getByRole("button", { name: "128 Antworten Letzte Antwort gestern um 23:59 Uhr", exact: true }).count(),
      ).toBe(1);
      expect(
        await thread.evaluate((bar) => bar.getBoundingClientRect().right <= bar.closest(".k2b-message-row")!.getBoundingClientRect().right),
      ).toBe(true);
      const rows = await page.evaluate(() => Object.fromEntries((window as unknown as { heights: Map<string, number[]> }).heights));
      for (const [key, sizes] of Object.entries(rows)) expect(new Set(sizes).size, `${key}: ${sizes.join(", ")}`).toBe(1);

      await rowOf(page, "m15").getByRole("button", { name: "Stoppen" }).click();
      expect((await recorded(page)).stopped).toBe(1);
    } finally {
      await page.close();
    }
  }, 30_000);

  for (const rich of [false, true])
    for (const width of [390, 720])
      for (const theme of ["light", "dark"] as const)
        for (const locale of ["en", "de"] as const)
          test(`renders every ${rich ? "rich " : ""}state readably at ${width}px in ${theme}, ${locale}`, async () => {
            const page = await open({ width, theme, locale, rich });
            try {
              await page.evaluate(() => fixture.setReceipt("Read by Nora"));
              const result = await page.evaluate(() => {
                // A canvas resolves every color syntax, including the color() that color-mix() computes to.
                const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
                const luminance = (color: string) => {
                  context.clearRect(0, 0, 1, 1);
                  context.fillStyle = color;
                  context.fillRect(0, 0, 1, 1);
                  const [r, g, b] = Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3), (value) => {
                    const channel = value / 255;
                    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                  });
                  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
                };
                const contrast = (a: string, b: string) => {
                  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
                  return (light! + 0.05) / (dark! + 0.05);
                };
                const surface = getComputedStyle(document.body).backgroundColor;
                const pairs: Record<string, number> = {};
                for (const row of document.querySelectorAll<HTMLElement>(".k2b-virtual-feed__item")) {
                  const key = row.dataset.key!;
                  const bubble = row.querySelector(".k2b-message-row__bubble");
                  const text = row.querySelector(".k2b-message-row__text");
                  if (bubble && text)
                    pairs[`${key} text`] = contrast(getComputedStyle(text).color, getComputedStyle(bubble).backgroundColor);
                  // Text drawn on a fill of its own: the edited marker on the bubble, chips on their fill.
                  for (const [name, selector, fill] of [
                    ["edited", ".k2b-message-row__edited", ".k2b-message-row__bubble"],
                    ["reaction", ".k2b-message-row__reaction", ".k2b-message-row__reaction"],
                    ["own reaction", ".k2b-message-row__reaction[data-own]", ".k2b-message-row__reaction[data-own]"],
                    ["file", ".k2b-message-row__file-name", ".k2b-message-row__file"],
                    ["file detail", ".k2b-message-row__file-detail", ".k2b-message-row__file"],
                  ] as const) {
                    const element = row.querySelector(selector);
                    if (element)
                      pairs[`${key} ${name}`] = contrast(
                        getComputedStyle(element).color,
                        getComputedStyle(row.querySelector(fill)!).backgroundColor,
                      );
                  }
                  const avatar = row.querySelector<HTMLElement>("span.k2b-avatar");
                  if (avatar) pairs[`${key} avatar`] = contrast(getComputedStyle(avatar).color, getComputedStyle(avatar).backgroundColor);
                  for (const [name, selector] of [
                    ["time", ".k2b-message-row__time"],
                    ["line", ".k2b-message-row__line"],
                    ["system", ".k2b-message-system-row"],
                    ["quote", ".k2b-message-row__quote"],
                    ["quote author", ".k2b-message-row__quote-author"],
                    ["marker", ".k2b-message-row__marker"],
                    ["deleted", ".k2b-message-row__deleted"],
                    ["thread", ".k2b-message-row__thread-count"],
                    ["thread time", ".k2b-message-row__thread-time"],
                  ] as const) {
                    const element = row.querySelector(selector);
                    if (element) pairs[`${key} ${name}`] = contrast(getComputedStyle(element).color, surface);
                  }
                }
                return { pairs, overflow: document.querySelector(".k2b-virtual-feed__viewport")!.scrollWidth > innerWidth };
              });
              for (const [pair, ratio] of Object.entries(result.pairs)) expect(ratio, pair).toBeGreaterThanOrEqual(4.5);
              expect(result.overflow).toBe(false);
              const line = async (key: string) =>
                (await rowOf(page, key).locator(".k2b-message-row__line").innerText()).replace(/\s+/g, " ");
              const words = async (key: string, selector: string) =>
                (await rowOf(page, key).locator(selector).innerText()).replace(/\s+/g, " ").trim();
              if (rich) {
                expect(Object.keys(result.pairs)).toEqual(
                  expect.arrayContaining([
                    "m11 edited",
                    "m11 reaction",
                    "m11 own reaction",
                    "m12 file detail",
                    "m14 marker",
                    "m16 deleted",
                    "m11 thread",
                  ]),
                );
                expect(await words("m11", ".k2b-message-row__edited")).toBe(locale === "de" ? "bearbeitet" : "edited");
                expect(await words("m14", ".k2b-message-row__marker")).toBe(locale === "de" ? "Weitergeleitet" : "Forwarded");
                expect(await words("m16", ".k2b-message-row__deleted")).toBe(
                  locale === "de" ? "Diese Nachricht wurde gelöscht" : "This message was deleted",
                );
                expect(
                  await rowOf(page, "m11")
                    .getByRole("button", {
                      name: locale === "de" ? "3 Antworten Letzte Antwort 10:42" : "3 replies Last reply 10:42",
                      exact: true,
                    })
                    .count(),
                ).toBe(1);
                expect(await line("m15")).toBe(locale === "de" ? "Writing Stoppen" : "Writing Stop");
              } else {
                expect(await line("m6")).toBe(locale === "de" ? "Wird gesendet" : "Sending");
                expect(await line("m8")).toBe(locale === "de" ? "Nicht gesendet Erneut senden" : "Not sent Retry");
                expect(await line("m7")).toBe("Read by Nora");
              }
              await page.screenshot({
                path: `/tmp/k2b-ui-message-rows-${browserName}-${rich ? "rich-" : ""}${width}-${theme}-${locale}.png`,
              });
            } finally {
              await page.close();
            }
          }, 30_000);
});
