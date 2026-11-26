import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-head-overflow.client";
import { measureV2Layout } from "./testing";

// The worst case of a head and of a name in a table (test/v2-head-overflow.client.tsx, break-ui of Mail's admin): a
// long subject beside the actions of a head, in the workspace and in a pane, and long names beside their marks in a
// table. The actions and the marks keep their size and stay inside; the subject and the names give way with "…".

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-head-overflow.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
    );
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** Each head bar: its subject (cut with "…", clear of the actions) and each action in sight (whole, inside the bar). */
const heads = () =>
  [...document.querySelectorAll<HTMLElement>('[data-slot="head"] > .k2-bar')].map((bar) => {
    const box = bar.getBoundingClientRect();
    const subject = bar.querySelector<HTMLElement>(".k2-bar-start > .k2-text")!;
    const end = bar.querySelector<HTMLElement>(".k2-bar-end")!;
    const actions = [...end.querySelectorAll<HTMLElement>(".k2-btn")].filter((button) => button.checkVisibility());
    const style = getComputedStyle(subject);
    return {
      subject: {
        cut: subject.scrollWidth > subject.clientWidth,
        ellipsis: style.textOverflow === "ellipsis",
        clear: subject.getBoundingClientRect().right <= (actions[0]?.getBoundingClientRect().left ?? box.right) + 0.5,
      },
      actions: actions.map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          name: button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
          inside: rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5,
          whole: button.scrollWidth <= button.clientWidth + 0.5,
        };
      }),
    };
  });

/** Each name cell in sight: its marks (whole, inside the line, not squeezed) and its name (cut with "…" or whole). */
const cells = () =>
  [...document.querySelectorAll<HTMLElement>(".k2-table .k2-cell-line > .k2-inline")]
    .filter((line) => line.checkVisibility() && line.getBoundingClientRect().width > 0)
    .map((line) => {
      const room = line.getBoundingClientRect();
      const name = line.querySelector<HTMLElement>(".k2-text")!;
      const marks = [...line.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child !== name);
      return {
        name: {
          text: name.textContent?.trim().slice(0, 12),
          // a cut name ends with "…"; a whole one is not cut
          fair: name.scrollWidth <= name.clientWidth + 0.5 || getComputedStyle(name).textOverflow === "ellipsis",
          clear: marks.every((mark) => {
            const rect = mark.getBoundingClientRect();
            const own = name.getBoundingClientRect();
            return rect.right <= own.left + 0.5 || rect.left >= own.right - 0.5;
          }),
        },
        marks: marks.map((mark) => {
          const rect = mark.getBoundingClientRect();
          return {
            mark: mark.className.split(" ")[0],
            inside: rect.left >= room.left - 0.5 && rect.right <= room.right + 0.5,
            // a mark keeps its own width: its content never needs more than it has
            whole: mark.scrollWidth <= mark.clientWidth + 0.5 && rect.width > 0,
          };
        }),
      };
    });

for (const width of [1440, 390])
  test(`at ${width} px a long subject gives way to the head's actions, and long names to their marks`, async () => {
    await withPage(width, async (page) => {
      const found = await page.evaluate(heads);
      expect(found.length).toBe(2);
      for (const head of found) {
        expect(head.actions.length).toBeGreaterThan(0);
        for (const action of head.actions) expect(action).toEqual({ ...action, inside: true, whole: true });
        expect(head.subject).toEqual({ cut: true, ellipsis: true, clear: true });
      }
      const lines = await page.evaluate(cells);
      // the table shows its columns on a wide screen; the phone shows its own rows
      if (width === 1440) expect(lines.length).toBe(8);
      for (const line of lines) {
        expect(line.name).toEqual({ ...line.name, fair: true, clear: true });
        for (const mark of line.marks) expect(mark).toEqual({ ...mark, inside: true, whole: true });
      }
      // and the layout measurement sees no control sticking out and no cut label
      const layout = await measureV2Layout(page);
      expect([...layout.out, ...layout.cut]).toEqual([]);
    });
  });
