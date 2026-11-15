import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../test/browser";
import type { ChatActivityProps } from "../index";

// Whether the right columns of a list of steps end on one edge depends on the shipped grid, so a real engine lays out
// rows with and without meta, duration, ⓘ, and chevron at phone and desktop widths. The card behind the ⓘ is
// `HoverCard`'s own contract (hover-card*.browser.test.ts); the chat's gallery tests it on real steps.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-chat-activity-grid-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Chat } = await import("../index");

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");

const rows = (long: boolean): ChatActivityProps[] => [
  { label: "Read the November sales", icon: "ti ti-file", duration: long ? "12 Min." : "1 s", info: info("Read") },
  { label: "Loaded tools and knowledge", icon: "ti ti-stack-2", meta: "2 steps", duration: "1 s", children: "Two steps" },
  {
    label: "Added up the numbers from the file, with a long sentence that does not fit the row",
    icon: "ti ti-calculator",
    meta: "Failed",
    metaTone: "danger",
    duration: long ? "1 Std." : "2 s",
    info: info("Added up"),
  },
  { label: "Thought it over", icon: "ti ti-bulb", duration: "4 s" },
  { label: "Sent mail", icon: "ti ti-mail", meta: "Outcome unclear", metaTone: "warning" },
];

function info(name: string) {
  return { label: `Details: ${name}`, title: name, detail: "3 s", content: "37 bookings found" as JSX.Element };
}

const html = (long: boolean) =>
  rows(long)
    .map((row) => renderToString(() => createComponent(Chat.Activity, row)))
    .join("");

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number, long: boolean) => {
  const page = await browser.newPage({ viewport: { width, height: 700 }, colorScheme: "light" });
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" style="margin:0;padding:16px"><div id="list" style="max-width:48rem;margin:0 auto">${html(long)}</div></body></html>`,
  );
  return page;
};

/** Right edges of each row's right columns, and the row boxes, relative to the list. */
const measure = (page: Awaited<ReturnType<typeof open>>) =>
  page.$eval("#list", (list) => {
    const edge = list.getBoundingClientRect().right;
    const right = (node: Element | null) => (node ? edge - node.getBoundingClientRect().right : null);
    return [...list.querySelectorAll<HTMLElement>(".k2b-chat-activity__row")].map((row) => {
      const box = row.getBoundingClientRect();
      const glyph = row.querySelector(".k2b-chat-activity__chevron, .k2b-chat-activity__info > i");
      return {
        meta: right(row.querySelector(".k2b-chat-activity__meta")),
        duration: right(row.querySelector(".k2b-chat-activity__duration")),
        end: right(glyph),
        icon: row.querySelector(".k2b-chat-activity__leading")!.getBoundingClientRect().left - list.getBoundingClientRect().left,
        box: { top: box.top, height: box.height, width: box.width },
      };
    });
  });

const sameEdge = (values: (number | null)[]) => {
  const present = values.filter((value): value is number => value !== null);
  expect(present.length).toBeGreaterThan(1);
  for (const value of present) expect(Math.abs(value - present[0]!)).toBeLessThanOrEqual(0.5);
};

for (const width of [390, 1440])
  for (const long of [false, true]) {
    test(`meta, duration, and ⓘ or chevron end on one edge in every row (${width}px, ${long ? "long" : "short"} durations)`, async () => {
      const page = await open(width, long);
      try {
        const before = await measure(page);
        sameEdge(before.map((row) => row.meta));
        sameEdge(before.map((row) => row.duration));
        sameEdge(before.map((row) => row.end));
        sameEdge(before.map((row) => row.icon));
        // One line per row: 32px, on a phone 44px.
        for (const row of before) expect(row.box.height).toBe(width === 390 ? 44 : 32);
        // Opening the group keeps every column of its own row where it was.
        await page.locator("summary.k2b-chat-activity__row").click();
        const after = await measure(page);
        expect(after[1]).toEqual(before[1]!);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      } finally {
        await page.close();
      }
    });
  }
