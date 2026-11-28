import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";

// W4 (Grids): a sidebar with many places pushed its foot ("Einstellungen") out of sight, because the groups stood
// directly in the nav, which clips and does not scroll. The groups now scroll between the head and the foot, as `list`
// and `tree` do: the head and the foot stay in sight, and the area shows no scroll bar of its own that would end the
// rows short of the column's edge (#4507). The page carries Cloud's scroll bar of 0.5rem, which WebKit draws.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } ::-webkit-scrollbar { width: 0.5rem; height: 0.5rem; }";

let browser: Browser;
let render: (few?: boolean) => string;
const temp = mkdtempSync(resolve(tmpdir(), "k2-v2-nav-groups-"));
beforeAll(async () => {
  const serverFile = resolve(temp, "server.js");
  await Bun.write(serverFile, await bundleV2Entry("v2-nav-groups.server.tsx", "ssr"));
  ({ render } = await import(serverFile));
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
});

const open = async (width: number, height: number, few = false): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(2000);
  await page.setContent(
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${render(few)}</div></body></html>`,
  );
  await settled(page);
  return page;
};

/** What the sidebar shows: its head, its foot, the groups' scroll, and how far a row reaches. */
const sidebar = (page: Page) =>
  page.evaluate(() => {
    const side = document.querySelector(".k2-ws-side")!.getBoundingClientRect();
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const inSide = (rect: DOMRect) => rect.top >= side.top && rect.bottom <= side.bottom + 0.5 && rect.height > 0;
    const groups = document.querySelector<HTMLElement>(".k2-nav-groups");
    const foot = box(".k2-nav-foot .k2-ni");
    // the foot's entry is the element a pointer reaches at its middle, so nothing covers it
    const hit = document.elementFromPoint(foot.left + foot.width / 2, foot.top + foot.height / 2);
    const row = box(".k2-nav-groups .k2-ni");
    return {
      titleInSight: inSide(box(".k2-nav-title")),
      footInSight: inSide(foot) && Boolean(hit?.closest(".k2-nav-foot")),
      scrolls: groups ? groups.scrollHeight > groups.clientHeight : false,
      // a scroll bar of its own would take width from the rows
      ownBar: groups ? groups.offsetWidth - groups.clientWidth : -1,
      rowRight: Math.round(row.right),
    };
  });

for (const [width, height] of [
  [1440, 900],
  [1024, 768],
] as const)
  test(`${width}×${height}: with many places the head and the foot stay in sight, and the groups scroll between them`, async () => {
    const few = await open(width, height, true);
    const { rowRight } = await sidebar(few);
    await few.close();
    const page = await open(width, height);
    try {
      expect(await sidebar(page)).toEqual({ titleInSight: true, footInSight: true, scrolls: true, ownBar: 0, rowRight });
      // the last place is reached by scrolling the groups; the head and the foot stay where they are
      const before = await page.evaluate(() => [
        document.querySelector(".k2-nav-title")!.getBoundingClientRect().top,
        document.querySelector(".k2-nav-foot")!.getBoundingClientRect().top,
      ]);
      await page.evaluate(() => {
        const groups = document.querySelector(".k2-nav-groups")!;
        groups.scrollTop = groups.scrollHeight;
      });
      await settled(page);
      const after = await page.evaluate(() => {
        const groups = document.querySelector(".k2-nav-groups")!.getBoundingClientRect();
        const entries = document.querySelectorAll(".k2-nav-groups .k2-ni");
        const last = entries[entries.length - 1]!.getBoundingClientRect();
        return {
          lastInSight: last.top >= groups.top && last.bottom <= groups.bottom + 0.5,
          places: [
            document.querySelector(".k2-nav-title")!.getBoundingClientRect().top,
            document.querySelector(".k2-nav-foot")!.getBoundingClientRect().top,
          ],
        };
      });
      expect(after).toEqual({ lastInSight: true, places: before });
    } finally {
      await page.close();
    }
  });

test("with few places nothing scrolls and the foot keeps its place at the bottom", async () => {
  const page = await open(1440, 900, true);
  try {
    const state = await sidebar(page);
    expect([state.titleInSight, state.footInSight, state.scrolls]).toEqual([true, true, false]);
    // the foot stands at the bottom of the sidebar, not under the groups
    const gap = await page.evaluate(
      () =>
        document.querySelector(".k2-ws-side")!.getBoundingClientRect().bottom -
        document.querySelector(".k2-nav-foot")!.getBoundingClientRect().bottom,
    );
    expect(gap).toBeLessThan(20);
  } finally {
    await page.close();
  }
});
