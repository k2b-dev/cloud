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
    // where the end stands: its start from the row's edge, and whether it has a line of its own below the statement
    end: (() => {
      const end = row.querySelector<HTMLElement>(".k2-bar-end")!.getBoundingClientRect();
      return { left: Math.round(end.left - box.left), ownLine: end.top >= lead.getBoundingClientRect().bottom - 0.5 };
    })(),
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

// On a wide screen the end stands whole beside the statement, in the row's one line of 52 px.
test("at 1440 px the end of a status row stands whole: its chips and its action, inside the row", async () => {
  await withPage(1440, async (page) => {
    const found = await page.evaluate(statusRow);
    expect(found.controls.map((control) => control.name)).toEqual(["Alle", "Apps", "Automationen", "Neue App"]);
    for (const control of found.controls) expect(control).toEqual({ ...control, seen: true, whole: true, inside: true });
    expect([found.height, found.lead.fair]).toEqual([52, true]);
  });
});

// On the phone the row keeps its one line of 52 px: what has no room beside the shortened statement folds into one
// "+n" from the end, named by how many it holds, which opens them as a menu (a pressed chip with its check).
test("at 390 px the end that has no room folds into one +n in the row's line of 52 px, and +n opens it", async () => {
  await withPage(390, async (page) => {
    const found = await page.evaluate(statusRow);
    expect([found.height, found.lead.fair]).toEqual([52, true]);
    const all = ["Alle", "Apps", "Automationen", "Neue App"];
    const shown = found.controls.filter((control) => control.seen && all.includes(control.name));
    for (const control of shown) expect(control).toEqual({ ...control, whole: true, inside: true });
    // the ones in sight are the first ones; the rest folded, the last first
    const folded = all.slice(shown.length);
    expect(shown.map((control) => control.name)).toEqual(all.slice(0, shown.length));
    expect(folded.length).toBeGreaterThan(0);
    const more = page.getByRole("button", { name: `${folded.length} weitere Filter` });
    expect(await more.textContent()).toContain(`+${folded.length}`);
    const box = await more.boundingBox();
    expect(box && box.x + box.width <= 390 + 0.5).toBe(true);
    await more.click();
    const items = await page
      .locator('[role^="menuitem"]')
      .evaluateAll((entries) => entries.map((entry) => [entry.textContent?.trim() ?? "", entry.getAttribute("aria-checked")]));
    expect(items.map(([name]) => name)).toEqual(folded);
    // a pressed chip that folded keeps its state as a check
    for (const [name, checked] of items) if (name === "Alle") expect(checked).toBe("true");
    await page.keyboard.press("Escape");
    // and nothing in the row is cut
    const layout = await measureV2Layout(page, { root: '[data-k2-part="StatusRow"]' });
    expect(layout.cut).toEqual([]);
  });
});
// An end that fits beside the statement keeps the row in its one line of exactly 52 px on the phone, too.
test("at 390 px a short statement and one action stand in the row's one line of 52 px", async () => {
  await withPage(390, async (page) => {
    await page.evaluate(() => window.__k2Short?.());
    await settled(page);
    const found = await page.evaluate(statusRow);
    expect(found.controls.map((control) => control.name)).toEqual(["Neue App"]);
    for (const control of found.controls) expect(control).toEqual({ ...control, seen: true, whole: true, inside: true });
    expect(found.height).toBe(52);
  });
});

// Chips in an `Inline`, as the table demo has them, fold the same way: each folded chip is a menu entry of its own clean
// words and symbol, a pressed one with its check.
test("at 390 px chips in a line fold into +n, each an entry of its words, symbol and state", async () => {
  await withPage(390, async (page) => {
    await page.evaluate(() => window.__k2Chips?.());
    await settled(page);
    const height = await page.evaluate(() =>
      Math.round(document.querySelector('[data-k2-part="StatusRow"]')!.getBoundingClientRect().height),
    );
    expect(height).toBe(52);
    const more = page.locator(".k2-bar-fold .k2-btn");
    const name = (await more.textContent()) ?? "";
    // what the eye reads ("+3") and what the name says ("3 weitere Filter")
    const count = Number(/^\+(\d+)$/.exec((await more.locator('span[aria-hidden="true"]').first().textContent()) ?? "")?.[1] ?? 0);
    expect(count).toBeGreaterThan(0);
    expect(name).toContain(`${count} weitere Filter`);
    await more.click();
    const items = await page.locator('[role^="menuitem"]').evaluateAll((entries) =>
      entries.map((entry) => ({
        name: entry.textContent?.trim() ?? "",
        checked: entry.getAttribute("aria-checked"),
        icon: entry.querySelector(".k2-icon[data-name]")?.getAttribute("data-name") ?? null,
      })),
    );
    expect(items.length).toBe(count);
    const words = ["Nach Status", "Verantwortlich: alle", "Filter", "Neue App"];
    expect(items.map((item) => item.name)).toEqual(words.slice(words.length - count));
    const status = items.find((item) => item.name === "Nach Status");
    if (status) expect(status).toEqual({ name: "Nach Status", checked: "true", icon: "layers-subtract" });
  });
});
