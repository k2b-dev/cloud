import { describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { browserName, launchBrowser, settled } from "../../../ui/test/browser";
import { type Device, installCompactShellHarness, laptop, open, phone } from "./compact-shell.browser-harness";

installCompactShellHarness(launchBrowser);

// A node inserted, removed or changed deep in an app page restyles its neighbourhood and at most a fixed part of the
// shell, never the page's content. In Chromium, any `:not()` or state pseudo-class inside any `:has()` argument makes
// every DOM change check `:has()`. The check then restyles every element in the document that matches a part after a
// non-subject `:has()` (`.a:has(.b) .c` restyles every `.c`), and with an anchor such as the document or the workspace
// the whole subtree below it. On a page with a few thousand elements that is a dropped frame per streamed message,
// typed key or toggled menu (#2420, #2492). CDP counts the elements each style pass visited; only Chromium has it.

/** Rows in the page's content. Doubling them must not add restyled elements. */
const ROWS = 1500;
/** The shell's fixed share: its head, tabs, sidebar rows and the changed node with its neighbours. */
const SHELL = 80;

/** Each change happens in an untouched row: `deep` is its selector. */
type Change = { name: string; run: (page: Page, deep: string) => Promise<void> };
const changes: Change[] = [
  {
    name: "inserting and removing a plain element",
    run: (page, deep) =>
      page.evaluate((deep) => {
        const node = document.createElement("span");
        document.querySelector(deep)!.append(node);
        return new Promise<void>((resolve) =>
          requestAnimationFrame(() => {
            node.remove();
            resolve();
          }),
        );
      }, deep),
  },
  {
    name: "inserting a paragraph with strong text and code",
    run: (page, deep) =>
      page.evaluate((deep) => {
        const node = document.createElement("p");
        node.innerHTML = "<strong>Note</strong> streamed <code>text</code>";
        document.querySelector(deep)!.append(node);
      }, deep),
  },
  {
    name: "opening a menu button",
    run: (page, deep) => page.evaluate((deep) => document.querySelector(`${deep} button`)!.setAttribute("aria-expanded", "true"), deep),
  },
];

const pages: { name: string; path: string; host: string }[] = [
  { name: "a workspace with sidebar, list and detail", path: "/app/mail/inbox", host: ".k2b-app-workspace__main" },
  { name: "an overview with views", path: "/app/mail/inbox?overview=1&objects=mail", host: ".k2b-app-workspace__main" },
  { name: "a page with workspace navigation", path: "/app/mail/inbox?navigation=1", host: ".k2b-app-workspace__main" },
  { name: "a task list with an open detail", path: "/app/mail/inbox?list=page&head=1", host: ".k2b-app-workspace__main" },
  { name: "a plain page", path: "/app/mail/inbox?plain=1", host: ".layout-content-main" },
];

/** The most elements one style pass visits while `change` happens and the next two frames render. */
const restyled = async (page: Page, change: Change, deep: string): Promise<number> => {
  const cdp = await page.context().newCDPSession(page);
  // Protocol types trace events as string maps; their `args` are objects.
  const events: Record<string, unknown>[] = [];
  cdp.on("Tracing.dataCollected", (event) => events.push(...event.value));
  await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline", transferMode: "ReportEvents" });
  await change.run(page, deep);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const complete = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.end");
  await complete;
  await cdp.detach();
  const elements = (event: Record<string, unknown>) => {
    const args = event.args;
    const count = typeof args === "object" && args !== null && "elementCount" in args ? args.elementCount : 0;
    return typeof count === "number" ? count : 0;
  };
  const passes = events.filter((event) => event.name === "UpdateLayoutTree" && event.ph === "X");
  return Math.max(0, ...passes.map(elements));
};

/** Appends rows of plain text and a menu button to the page's content. */
const addRows = (page: Page, host: string, rows: number) =>
  page.evaluate(
    ({ host, rows }) => {
      const list = document.querySelector("#restyle-probe") ?? document.querySelector(host)!.appendChild(document.createElement("div"));
      list.id = "restyle-probe";
      for (let index = 0; index < rows; index++) {
        const row = document.createElement("div");
        row.innerHTML = `<span>Row ${index}</span> <button type="button" aria-expanded="false">More</button>`;
        list.append(row);
      }
    },
    { host, rows },
  );

const devices: Device[] = [laptop, phone];

describe.skipIf(browserName !== "chromium")("a change deep in an app page restyles only its neighbourhood", () => {
  for (const device of devices)
    for (const target of pages)
      test(`${device.name}: ${target.name}`, async () => {
        // Each size in a fresh page: earlier changes leave nodes that a later pass would count again.
        const measure = async (rows: number) => {
          const { context, page } = await open(device, target.path);
          try {
            await addRows(page, target.host, rows);
            await settled(page);
            expect(await page.evaluate(() => document.querySelectorAll("*").length)).toBeGreaterThan(rows * 3);
            const counts: Record<string, number> = {};
            for (const [index, change] of changes.entries())
              counts[change.name] = await restyled(page, change, `#restyle-probe > :nth-child(${rows / 2 + index})`);
            return counts;
          } finally {
            await context.close();
          }
        };
        const small = await measure(ROWS);
        const large = await measure(ROWS * 2);
        // Neither the page's size nor its content shows in the count: only the shell's fixed share.
        const grown = changes.filter((change) => large[change.name]! > small[change.name]!);
        expect(grown.map((change) => `${change.name}: ${small[change.name]} → ${large[change.name]}`)).toEqual([]);
        const wide = changes.filter((change) => large[change.name]! > SHELL);
        expect(wide.map((change) => `${change.name}: ${large[change.name]}`)).toEqual([]);
      });
});
