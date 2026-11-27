import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-status-end.client";
import { measureV2Layout } from "./testing";

// The end of a status row stays reachable on the phone (test/v2-status-end.client.tsx, Assistant's "My apps"): its
// filter chips and its action to create stand whole and inside the row, in a second line where the first has no room;
// on a wide screen the row keeps its one line of 52 px.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
beforeAll(async () => {
  [client, browser] = await Promise.all([bundleV2Entry("v2-status-end.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (width: number, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
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

/** The status row: its height, its lead, and each control at its end (in sight, whole, inside the row). */
const statusRow = () => {
  const row = document.querySelector<HTMLElement>('[data-k2-part="StatusRow"]')!;
  const box = row.getBoundingClientRect();
  const lead = row.querySelector<HTMLElement>(".k2-status-lead")!;
  const leadStyle = getComputedStyle(lead);
  return {
    height: Math.round(box.height),
    lead: { fair: lead.scrollWidth <= lead.clientWidth + 0.5 || leadStyle.textOverflow === "ellipsis" },
    controls: [...row.querySelectorAll<HTMLElement>(".k2-bar-end .k2-btn")].map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        name: button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
        seen: button.checkVisibility() && rect.width > 0,
        whole: button.scrollWidth <= button.clientWidth + 0.5,
        inside:
          rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5 && rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5,
      };
    }),
  };
};

for (const width of [390, 1440])
  test(`at ${width} px the end of a status row stays reachable: its chips and its action whole, inside the row`, async () => {
    await withPage(width, async (page) => {
      const found = await page.evaluate(statusRow);
      expect(found.controls.map((control) => control.name)).toEqual(["Alle", "Apps", "Automationen", "Neue App"]);
      for (const control of found.controls) expect(control).toEqual({ ...control, seen: true, whole: true, inside: true });
      expect(found.lead.fair).toBe(true);
      // a wide screen keeps the one line of 52 px; the phone may take a second line for the end
      if (width === 1440) expect(found.height).toBe(52);
      else expect(found.height).toBeGreaterThanOrEqual(52);
      // the action to create works from the phone too
      await page.getByRole("button", { name: "Neue App" }).click();
      const layout = await measureV2Layout(page, { root: '[data-k2-part="StatusRow"]' });
      expect([...layout.cut, ...layout.edge]).toEqual([]);
    });
  });
