import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import type {} from "../../test/v2-bar-fold.fixture";
import { bundleV2Entry } from "../../test/v2-bundle";

// A bar whose end does not fit (W7's head of kept actions beside tabs, W2's "1.000 Kommentare"): the start keeps its
// least, the end folds first into "…" in its order (the primary never), and only then the start shortens, never to
// nothing. The fixture is test/v2-bar-fold.fixture.tsx.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; } .case { position: relative; height: 300px; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
let server: { html: string; script: string };
const temp = mkdtempSync(resolve(tmpdir(), "k2-v2-bar-fold-"));
beforeAll(async () => {
  const serverFile = resolve(temp, "server.js");
  await Bun.write(serverFile, await bundleV2Entry("v2-bar-fold.server.tsx", "ssr"));
  const { render }: { render: () => { html: string; script: string } } = await import(serverFile);
  server = render();
  [client, browser] = await Promise.all([bundleV2Entry("v2-bar-fold.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
});

/** The page as the server sent it; with `live` hydrated, which fails on any node the client would make differently. */
const withPage = async (width: number, live: boolean, run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${server.script}<style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${server.html}</div></body></html>`,
    );
    if (live) {
      await page.addScriptTag({ content: client });
      await page.waitForFunction(() => window.__k2Hydrated === true);
    }
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const head = (which: string) => `[data-case="${which}"] .k2-ws-main > [data-slot="head"] > .k2-bar`;
const actions = ["Teilen", "Drucken", "Exportieren", "Verlauf", "Favorit", "Archivieren"];
const more = "Weitere Aktionen";

/** The controls of a head a person sees, by name, with their edges; cut ones count with the part in sight. */
const seen = (page: Page, bar: string) =>
  page.evaluate((bar) => {
    const found: { name: string; left: number; right: number }[] = [];
    const end = document.querySelector(`${bar} > .k2-bar-end`)?.getBoundingClientRect();
    for (const control of document.querySelectorAll<HTMLElement>(`${bar} :is(.k2-btn, .k2-tab)`)) {
      const box = control.getBoundingClientRect();
      // a tab that gave way stands hidden in its place (`visibility: hidden`); a button the end cut lies beyond it
      if (!control.checkVisibility({ visibilityProperty: true }) || box.width === 0) continue;
      if (end && control.closest(".k2-bar-end") && box.left >= end.right - 4) continue;
      const name = control.getAttribute("aria-label") ?? control.textContent?.trim() ?? "";
      found.push({ name, left: Math.round(box.left), right: Math.round(box.right) });
    }
    return found;
  }, bar);
/** The edges of the start and the end of a bar, and the bar's content edge. */
const edges = (page: Page, bar: string) =>
  page.evaluate((bar) => {
    const element = document.querySelector<HTMLElement>(bar)!;
    const start = element.querySelector(":scope > .k2-bar-start")?.getBoundingClientRect();
    const endElement = element.querySelector(":scope > .k2-bar-end");
    const end = endElement?.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const content = box.right - Number.parseFloat(getComputedStyle(element).paddingRight);
    // the end keeps 4 px inside its cut for the rings of its buttons: its buttons end where its padding starts
    const inner = (side: "Left" | "Right") => (endElement ? Number.parseFloat(getComputedStyle(endElement)[`padding${side}`]) : 0);
    return {
      start: start ? { left: Math.round(start.left), width: Math.round(start.width), right: start.right } : null,
      end: end ? { left: end.left + inner("Left"), right: end.right - inner("Right") } : null,
      content,
    };
  }, bar);
const frames = (page: Page) =>
  page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

test("390 px, alive: the start stays whole, the last actions are in '…' in their order, and the primary stays", async () => {
  await withPage(390, true, async (page) => {
    const shown = await seen(page, head("record"));
    const names = shown.map((control) => control.name);
    for (const control of shown) expect([control.name, control.right <= 390, control.left >= 0]).toEqual([control.name, true, true]);
    // the end folds first: both tabs stay
    expect(names.slice(0, 2)).toEqual(["Übersicht", "Dateien"]);
    expect(names.slice(-2)).toEqual(["Neu", more]);
    const kept = names.filter((name) => actions.includes(name));
    expect(kept).toEqual(actions.slice(0, kept.length));
    expect(kept.length).toBeLessThan(actions.length);
    await page.locator(head("record")).getByRole("button", { name: more }).click();
    const entries = await page.locator(".k2-menu").last().locator("[role^='menuitem']").allTextContents();
    expect(entries.map((entry) => entry.trim())).toEqual(actions.slice(kept.length));
    await page.getByRole("menuitem", { name: "Verlauf" }).click();
    expect(await page.evaluate(() => window.__deeds)).toEqual(["Verlauf"]);
  });
});

test("390 px: the server's page already shows the whole start, and at load only buttons turn into '…'", async () => {
  const starts: unknown[] = [];
  for (const live of [false, true])
    await withPage(390, live, async (page) => {
      const names = (await seen(page, head("record"))).map((control) => control.name);
      expect([live, names.slice(0, 2)]).toEqual([live, ["Übersicht", "Dateien"]]);
      const book = (await seen(page, head("book"))).map((control) => control.name);
      expect([live, book.includes("1.000 Kommentare") || book.some((name) => name.startsWith("1.000"))]).toEqual([live, true]);
      starts.push([(await edges(page, head("record"))).start, (await edges(page, head("menu"))).start]);
    });
  expect(starts[1]).toEqual(starts[0]);
});

test("390 px: the start gives way only after the end folded everything, down to its least and never to nothing", async () => {
  for (const live of [false, true])
    await withPage(390, live, async (page) => {
      const { start, end, content } = await edges(page, head("book"));
      if (!start || !end) throw new Error("no start or end");
      expect([live, start.width >= 120, start.right <= end.left + 0.5, end.right <= content + 0.5]).toEqual([live, true, true, true]);
      if (live) expect((await seen(page, head("book"))).map((control) => control.name).slice(-1)).toEqual([more]);
    });
});

test("390 px: the keyboard reads the head as the eye does, and '…' comes last", async () => {
  await withPage(390, true, async (page) => {
    const all = (await seen(page, head("record"))).map((control) => control.name);
    const names = all.slice(all.indexOf("Teilen"));
    await page.locator(head("record")).getByRole("button", { name: "Teilen", exact: true }).focus();
    const order = [names[0]];
    for (let step = 1; step < names.length; step++) {
      await page.keyboard.press("Tab");
      order.push(
        await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim() ?? ""),
      );
    }
    expect(order).toEqual(names);
  });
});

test("an entry of '…' follows its button: pressed and disabled change in the open menu", async () => {
  await withPage(390, true, async (page) => {
    await page.locator(head("record")).getByRole("button", { name: more }).click();
    expect(await page.getByRole("menuitemcheckbox", { name: "Favorit" }).getAttribute("aria-checked")).toBe("false");
    await page.evaluate(() => {
      window.__k2Press?.();
      window.__k2Lock?.(true);
    });
    await page.waitForFunction(
      () => document.querySelector('[role="menuitemcheckbox"][aria-checked="true"]')?.textContent?.includes("Favorit") ?? false,
    );
    expect(await page.getByRole("menuitem", { name: "Archivieren" }).getAttribute("aria-disabled")).toBe("true");
  });
});

test("a button that folds while it has the focus hands it to '…'", async () => {
  await withPage(1440, true, async (page) => {
    await page.locator(head("record")).getByRole("button", { name: "Archivieren" }).focus();
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Weitere Aktionen");
    expect(await page.evaluate(() => document.activeElement?.closest(".k2-bar") !== null)).toBe(true);
  });
});

test("an end that ends with its own '…' takes the folded actions as its first section; no second '…'", async () => {
  await withPage(390, true, async (page) => {
    const names = (await seen(page, head("menu"))).map((control) => control.name);
    expect(names.filter((name) => name === more)).toEqual([more]);
    expect(await page.locator(`${head("menu")} .k2-bar-fold`).count()).toBe(0);
    const kept = names.filter((name) => actions.includes(name));
    await page.locator(head("menu")).getByRole("button", { name: more }).click();
    const entries = await page.locator(".k2-menu").last().locator("[role^='menuitem']").allTextContents();
    expect(entries.map((entry) => entry.trim())).toEqual([...actions.slice(kept.length, 4), "Umbenennen", "Löschen"]);
  });
});

test("an open menu in the end folds nothing: its popup is no part of the row", async () => {
  for (const width of [1440, 390])
    await withPage(width, true, async (page) => {
      const before = await seen(page, head("menu"));
      await page.locator(head("menu")).getByRole("button", { name: more }).click();
      await page.locator(".k2-menu").last().waitFor();
      await frames(page);
      expect([width, await seen(page, head("menu"))]).toEqual([width, before]);
    });
});

test("1440 px: a head that fits folds nothing and has no '…', on the server's page and after it came alive", async () => {
  let before: Awaited<ReturnType<typeof seen>> = [];
  await withPage(1440, false, async (page) => {
    before = await seen(page, head("record"));
  });
  await withPage(1440, true, async (page) => {
    const after = await seen(page, head("record"));
    expect(after.map((control) => control.name)).toEqual(["Übersicht", "Dateien", ...actions, "Neu"]);
    expect(after).toEqual(before);
  });
});

test("every 8 px from 320 to 1440: each end ends inside its bar's content edge, beside its start", async () => {
  await withPage(320, true, async (page) => {
    const wrong: string[] = [];
    for (let width = 320; width <= 1440; width += 8) {
      await page.setViewportSize({ width, height: 1000 });
      await frames(page);
      await frames(page);
      for (const which of ["record", "book", "menu"]) {
        const { start, end, content } = await edges(page, head(which));
        if (!end) continue;
        if (end.right > content + 0.5) wrong.push(`${which} at ${width}: the end ends ${Math.round(end.right - content)} px beyond`);
        if (start && start.right > end.left + 0.5) wrong.push(`${which} at ${width}: the start runs under the end`);
      }
    }
    expect(wrong).toEqual([]);
  });
}, 60_000);
