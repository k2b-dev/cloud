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
const [statuses, setStatuses] = createSignal({ m6: "pending", m7: "sent", m8: "failed" });
const [receipt, setReceipt] = createSignal();
window.retried = 0;
const messages = [
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
].map((message) => ({ ...message, at: start + message.minute * 60_000 }));
const index = new Map(messages.map((message, position) => [message.id, position]));
const entryOf = (message) => message && { author: message.author ?? "system", at: message.at, system: message.system };
const actions = [
  { id: "reply", label: options.locale === "de" ? "Antworten" : "Reply", icon: "ti ti-arrow-back-up", onSelect: () => (window.replied = (window.replied ?? 0) + 1) },
  { id: "react", label: options.locale === "de" ? "Reagieren" : "React", icon: "ti ti-mood-smile", onSelect: () => {} },
];
const time = (message) => new Date(message.at).toISOString().slice(11, 16);
const feed = () =>
  createComponent(VirtualFeed, {
    items: messages,
    getKey: (message) => message.id,
    estimateSize: () => 64,
    label: "Conversation",
    itemLabel: (message) => (message.system ? undefined : people[message.author].name + ", " + time(message)),
    children: (message) =>
      message.system
        ? createComponent(MessageSystemRow, { icon: "ti ti-user-plus", time: time(message), children: message.text })
        : createComponent(MessageRow, {
            author: people[message.author],
            text: message.text,
            time: time(message),
            dateTime: new Date(message.at),
            own: message.own,
            groupStart: startsMessageGroup(entryOf(message), entryOf(messages[index.get(message.id) - 1])),
            badge: message.badge ? "Agent" : undefined,
            get status() {
              return message.own ? statuses()[message.id] : undefined;
            },
            get receipt() {
              return message.id === "m7" ? receipt() : undefined;
            },
            onRetry: () => window.retried++,
            actions,
          }),
  });
render(
  () => createComponent(LocaleProvider, { locale: options.locale ?? "en", get children() { return feed(); } }),
  document.getElementById("app"),
);
window.fixture = { setStatuses, setReceipt };
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
type Fixture = { setStatuses: (next: Record<string, string>) => void; setReceipt: (text?: string) => void };
declare const fixture: Fixture;
declare const retried: number;
declare const replied: number | undefined;
declare const hit: number | undefined;

const open = async (options: { width?: number; theme?: Theme; locale?: "en" | "de" } = {}): Promise<Page> => {
  const width = options.width ?? 720;
  const page = await browser.newPage({ viewport: { width, height: 1400 } });
  page.on("dialog", (dialog) => void dialog.dismiss());
  await page.route(`${assets}**`, (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
  );
  await page.setContent(
    `<!doctype html><html lang="${options.locale ?? "en"}"><head><style>${css}</style><style>${fonts}</style>` +
      "<style>*,*::before,*::after{transition:none!important}</style></head>" +
      `<body class="k2b-ui${options.theme === "dark" ? " k2b-dark" : ""}" style="margin:0;background:var(--k2b-surface)">` +
      `<div id="app" style="display:flex;width:${width}px;height:1400px"></div></body></html>`,
  );
  // Fonts first: a font that arrives late changes every text's height, which is not the row's doing.
  await page.evaluate(async () => {
    await Promise.all(
      [
        "400 15px 'IBM Plex Sans'",
        "600 15px 'IBM Plex Sans'",
        "700 15px 'IBM Plex Sans'",
        "400 13px 'IBM Plex Mono'",
        "16px tabler-icons",
      ].map((font) => document.fonts.load(font)),
    );
  });
  await page.evaluate((locale) => {
    (window as unknown as { fixtureOptions: object }).fixtureOptions = { locale };
    // Record every row's height from the frame it mounts in; a later change would move the rows below it.
    const heights = new Map<string, number[]>();
    (window as unknown as { heights: typeof heights }).heights = heights;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.key!;
        heights.set(key, [...(heights.get(key) ?? []), entry.borderBoxSize[0]!.blockSize]);
      }
    });
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) if (node instanceof HTMLElement && node.dataset.key) observer.observe(node);
    }).observe(document.getElementById("app")!, { childList: true, subtree: true });
  }, options.locale ?? "en");
  await page.addScriptTag({ content: script });
  await page.locator('[data-key="m10"] .k2b-message-row').waitFor();
  await page.mouse.move(width - 1, 1399);
  return page;
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
      expect(await page.evaluate(() => replied)).toBe(1);
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
      expect(
        await rowOf(page, "m7")
          .locator(".k2b-message-row__receipt")
          .evaluate((text) => text.scrollWidth > text.clientWidth),
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

  for (const width of [390, 720])
    for (const theme of ["light", "dark"] as const)
      for (const locale of ["en", "de"] as const)
        test(`renders every state readably at ${width}px in ${theme}, ${locale}`, async () => {
          const page = await open({ width, theme, locale });
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
                if (bubble)
                  pairs[`${key} text`] = contrast(
                    getComputedStyle(row.querySelector(".k2b-message-row__text")!).color,
                    getComputedStyle(bubble).backgroundColor,
                  );
                const avatar = row.querySelector<HTMLElement>("span.k2b-avatar");
                if (avatar) pairs[`${key} avatar`] = contrast(getComputedStyle(avatar).color, getComputedStyle(avatar).backgroundColor);
                for (const [name, selector] of [
                  ["time", ".k2b-message-row__time"],
                  ["line", ".k2b-message-row__line"],
                  ["system", ".k2b-message-system-row"],
                ] as const) {
                  const element = row.querySelector(selector);
                  if (element) pairs[`${key} ${name}`] = contrast(getComputedStyle(element).color, surface);
                }
              }
              return { pairs, overflow: document.querySelector(".k2b-virtual-feed__viewport")!.scrollWidth > innerWidth };
            });
            for (const [pair, ratio] of Object.entries(result.pairs)) expect(ratio, pair).toBeGreaterThanOrEqual(4.5);
            expect(result.overflow).toBe(false);
            const line = async (key: string) => (await rowOf(page, key).locator(".k2b-message-row__line").innerText()).replace(/\s+/g, " ");
            expect(await line("m6")).toBe(locale === "de" ? "Wird gesendet" : "Sending");
            expect(await line("m8")).toBe(locale === "de" ? "Nicht gesendet Erneut senden" : "Not sent Retry");
            expect(await line("m7")).toBe("Read by Nora");
            await page.screenshot({ path: `/tmp/k2b-ui-message-rows-${browserName}-${width}-${theme}-${locale}.png` });
          } finally {
            await page.close();
          }
        }, 30_000);
});
