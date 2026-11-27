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
const actions = ["Teilen", "Drucken", "Exportieren", "Verlauf", "Duplizieren", "Favorit", "Archivieren"];
const tabs = ["Übersicht", "Aktivität", "Dateien"];
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
    // the end folds first: every tab stays
    expect(names.slice(0, 3)).toEqual(tabs);
    expect(names.slice(-2)).toEqual(["Neu", more]);
    const kept = names.filter((name) => actions.includes(name));
    expect(kept).toEqual(actions.slice(0, kept.length));
    expect(kept.length).toBeLessThan(actions.length);
    await page.locator(head("record")).getByRole("button", { name: more }).click();
    const entries = await page.locator(".k2-menu").last().locator("[role^='menuitem']").allTextContents();
    expect(entries.map((entry) => entry.trim())).toEqual(actions.slice(kept.length));
    await page.getByRole("menuitem", { name: "Duplizieren" }).click();
    expect(await page.evaluate(() => window.__deeds)).toEqual(["Duplizieren"]);
  });
});

/** The boxes of a bar's start, its parts, its end and the end's buttons. */
const rects = (page: Page, bar: string) =>
  page.evaluate((bar) => {
    const element = document.querySelector(bar)!;
    return [":scope > .k2-bar-start", ":scope > .k2-bar-start > *", ":scope > .k2-bar-end", ":scope > .k2-bar-end .k2-btn"].flatMap(
      (selector) =>
        [...element.querySelectorAll(selector)].map((found) => {
          const box = found.getBoundingClientRect();
          return [box.left, box.top, box.width, box.height];
        }),
    );
  }, bar);

// One test per width: each loads the server's page and the live one, so a test stays two pages within its budget.
for (const width of [240, 320, 390, 1024])
  test(`${width} px, a long start beside an end that folds nothing: the server's page is the live one (±1 px), also where the end cuts`, async () => {
    // "long": one button that fits; "closes": a primary with words and a closing button, which fold nothing and, at 240
    // px, beside the start's least, have to be cut from the start of the end
    const sent: Record<string, number[][]> = {};
    await withPage(width, false, async (page) => {
      for (const which of ["long", "closes"]) sent[which] = await rects(page, head(which));
    });
    await withPage(width, true, async (page) => {
      for (const which of ["long", "closes"]) {
        expect([which, await page.locator(`${head(which)} .k2-bar-fold`).count()]).toEqual([which, 0]);
        const live = await rects(page, head(which));
        const apart = live
          .flatMap((box, at) => box.map((value, side) => Math.abs(value - sent[which]![at]![side]!)))
          .filter((gap) => gap > 1);
        expect([which, live.length, apart]).toEqual([which, sent[which]!.length, []]);
      }
      // the closing button, which never folds, stays in sight at the end
      const close = await page.locator(head("closes")).getByRole("button", { name: "Schließen" }).boundingBox();
      const end = await edges(page, head("closes"));
      expect(close !== null && close.x + close.width <= end.end!.right + 0.5).toBe(true);
    });
  });

test("a quiet label of 16ch and more beside the title: the title keeps a few letters, the label shortens too", async () => {
  for (const live of [false, true])
    await withPage(240, live, async (page) => {
      const widths = await page.locator(`${head("changes")} > .k2-bar-start`).evaluate((start) =>
        [...start.querySelectorAll<HTMLElement>(":scope > .k2-text")].map((text) => {
          const probe = document.createElement("span");
          probe.style.cssText = "position:absolute;visibility:hidden;width:3ch";
          text.append(probe);
          const three = probe.getBoundingClientRect().width;
          probe.remove();
          return { width: text.getBoundingClientRect().width, cut: text.scrollWidth > text.clientWidth + 0.5, three };
        }),
      );
      const [label, title] = widths;
      // the title keeps at least a few letters; once it stands at that floor (4ch), the label is the one that shortens
      const atFloor = title!.width <= (title!.three / 3) * 4 + 1;
      expect([live, title!.width >= title!.three, !atFloor || label!.cut]).toEqual([live, true, true]);
    });
});

test("390 px: the start gives way only after the end folded everything, down to its least and never to nothing", async () => {
  for (const live of [false, true])
    await withPage(390, live, async (page) => {
      const { start, end, content } = await edges(page, head("book"));
      if (!start || !end) throw new Error("no start or end");
      // the least is the shared token `--k2-start-least` (16ch of the start's own type)
      const least = await page.locator(`${head("book")} > .k2-bar-start`).evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.cssText = "display:block;width:var(--k2-start-least)";
        element.append(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        return width;
      });
      expect([live, least > 0, start.width >= Math.floor(least), start.right <= end.left + 0.5, end.right <= content + 0.5]).toEqual([
        live,
        true,
        true,
        true,
        true,
      ]);
      if (live) expect((await seen(page, head("book"))).map((control) => control.name).slice(-1)).toEqual([more]);
    });
});

test("390 px: the keyboard reads the head as the eye does, and '…' comes last", async () => {
  await withPage(390, true, async (page) => {
    // the end of the head as the eye reads it, from its first button on
    const names = (await seen(page, head("menu"))).map((control) => control.name).filter((name) => name !== "");
    expect(names.at(-1)).toBe(more);
    await page.locator(head("menu")).getByRole("button", { name: names[0], exact: true }).focus();
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
      () => document.querySelector('[role="menuitemcheckbox"][aria-checked="true"]')?.textContent?.includes("Favorit entfernen") ?? false,
    );
    expect(await page.getByRole("menuitem", { name: "Archivieren" }).getAttribute("aria-disabled")).toBe("true");
  });
});

test("the entry the keys stand on turns disabled and gets new words in the open menu: the focus stays in the menu", async () => {
  await withPage(390, true, async (page) => {
    await page.locator(head("record")).getByRole("button", { name: more }).focus();
    await page.keyboard.press("Enter");
    const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim() ?? document.activeElement?.tagName);
    // the keys go to the last entry, "Archivieren", and it turns disabled under them
    await page.keyboard.press("End");
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Archivieren");
    await page.evaluate(() => window.__k2Lock?.(true));
    await page.waitForFunction(() => document.querySelector('[role="menuitem"][aria-disabled="true"]') !== null);
    expect(await page.evaluate(() => document.activeElement?.closest(".k2-menu") !== null)).toBe(true);
    // one up is "Favorit", which gets new words under the keys
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Favorit");
    await page.evaluate(() => window.__k2Press?.());
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Favorit entfernen");
    await page.keyboard.press("ArrowUp");
    expect(await focused()).toBe("Duplizieren");
  });
});

test("Mail's reader: its own '…' takes the folded actions; a menu with a symbol of its own ('Später') takes none", async () => {
  await withPage(390, true, async (page) => {
    const names = (await seen(page, head("reader"))).map((control) => control.name);
    expect(names.filter((name) => name === more)).toEqual([more]);
    expect(await page.locator(`${head("reader")} .k2-bar-fold`).count()).toBe(0);
    expect(names).toContain("Erledigt");
    await page.locator(head("reader")).getByRole("button", { name: "Später" }).click();
    expect((await page.locator(".k2-menu").last().locator("[role^='menuitem']").allTextContents()).map((entry) => entry.trim())).toEqual([
      "Morgen früh",
    ]);
    await page.keyboard.press("Escape");
    await page.locator(head("reader")).getByRole("button", { name: more }).click();
    const entries = (await page.locator(".k2-menu").last().locator("[role^='menuitem']").allTextContents()).map((entry) => entry.trim());
    expect(entries.at(-1)).toBe("Weiterleiten");
    expect(entries.length).toBeGreaterThan(1);
  });
});

test("390 px: inside the start the last words take the shortage; a fixed label and a button before them stay whole", async () => {
  const whole = (page: Page, bar: string, selector: string) =>
    page.locator(`${bar} > .k2-bar-start > ${selector}`).evaluate((element) => {
      const label = element.querySelector(".k2-btn-label") ?? element;
      return label.scrollWidth <= label.clientWidth + 0.5;
    });
  for (const live of [false, true])
    await withPage(390, live, async (page) => {
      // Notebooks' version history: "Versionsverlauf" whole, the note title shortened
      expect([live, await whole(page, head("history"), ".k2-text:first-child")]).toEqual([live, true]);
      expect([live, await whole(page, head("history"), ".k2-text:last-child")]).toEqual([live, false]);
      // the notebook head, once its end folded (it has to: on the server's page its whole end leaves the start only
      // its least): the title gives first, "1.000 Kommentare" stays whole
      if (live) expect(await whole(page, head("book"), ".k2-btn")).toBe(true);
    });
});

test("a plain '…' before the primary takes the folded actions: no second '…', nothing new after the primary", async () => {
  await withPage(390, true, async (page) => {
    const names = (await seen(page, head("before"))).map((control) => control.name);
    expect(names.slice(-2)).toEqual([more, "Senden"]);
    expect(names.filter((name) => name === more)).toEqual([more]);
    expect(await page.locator(`${head("before")} .k2-bar-fold`).count()).toBe(0);
    await page.locator(head("before")).getByRole("button", { name: more }).click();
    const entries = (await page.locator(".k2-menu").last().locator("[role^='menuitem']").allTextContents()).map((entry) => entry.trim());
    // the folded actions first, in their order, then the menu's own
    expect(entries.slice(-2)).toEqual(["Vorschau", "Verwerfen"]);
    expect(entries.length).toBeGreaterThan(2);
  });
});

test("a folded link the keys stand on turns disabled in the open menu: it stays the entry with the focus", async () => {
  await withPage(390, true, async (page) => {
    await page.locator(head("before")).getByRole("button", { name: more }).focus();
    await page.keyboard.press("Enter");
    for (let step = 0; step < 4; step++) {
      if (await page.evaluate(() => document.activeElement?.textContent?.trim() === "Vorschau")) break;
      await page.keyboard.press("ArrowDown");
    }
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Vorschau");
    await page.evaluate(() => window.__k2Lock?.(true));
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-disabled") === "true");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Vorschau");
    await page.keyboard.press("ArrowDown");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Verwerfen");
  });
});

test("tabs that gave way to a button come back whole when it gives the room back; their 'Mehr' goes", async () => {
  await withPage(390, true, async (page) => {
    const names = async () => (await seen(page, head("record"))).map((control) => control.name);
    expect((await names()).slice(0, 3)).toEqual(tabs);
    const primary = page.locator(head("record")).getByRole("button", { name: "Neu" });
    await primary.evaluate((button) => {
      (button as HTMLElement).style.minWidth = "160px";
    });
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-case="record"] .k2-tab')].some((tab) => tab.textContent?.startsWith("Mehr")),
    );
    await primary.evaluate((button) => {
      (button as HTMLElement).style.minWidth = "";
    });
    await page.waitForFunction(
      () => ![...document.querySelectorAll('[data-case="record"] .k2-tab')].some((tab) => tab.textContent?.startsWith("Mehr")),
    );
    const after = await names();
    expect([after.slice(0, 3), after.some((name) => name.startsWith("Mehr"))]).toEqual([tabs, false]);
  });
});

test("a menu with a symbol and a name of its own at the end ('Filter') takes no folded actions", async () => {
  await withPage(390, true, async (page) => {
    await page.locator(head("tabs")).getByRole("button", { name: "Filter" }).click();
    expect((await page.locator(".k2-menu").last().locator("[role^='menuitem']").allTextContents()).map((entry) => entry.trim())).toEqual([
      "Nur ungelesene",
    ]);
    // what folds goes into the bar's own "…"
    expect(await page.locator(`${head("tabs")} .k2-bar-fold`).count()).toBe(1);
  });
});

test("a button that grows while the bar keeps its size (a late font, wider words) folds again: the start stays whole", async () => {
  await withPage(390, true, async (page) => {
    const before = (await edges(page, head("menu"))).start;
    // the first kept action grows, as words do when their font arrives: the bar keeps its size, its end does not
    await page
      .locator(head("menu"))
      .getByRole("button", { name: "Teilen", exact: true })
      .evaluate((button) => {
        (button as HTMLElement).style.minWidth = "120px";
      });
    await frames(page);
    await frames(page);
    const after = await edges(page, head("menu"));
    const names = (await seen(page, head("menu"))).map((control) => control.name);
    expect([after.start, names.at(-1)]).toEqual([before, more]);
    expect(after.end!.right <= after.content + 0.5).toBe(true);
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

/** The "…" buttons a person sees in a bar: the menus with the default symbol, the app's and the bar's own. */
const dots = (page: Page, bar: string) =>
  page.evaluate(
    (bar) =>
      [...document.querySelectorAll(`${bar} .k2-btn:has(> .k2-icon[data-name="dots"])`)].filter((button) =>
        button.checkVisibility({ visibilityProperty: true }),
      ).length,
    bar,
  );

test("390 px: an app's '…' with a name of its own ('Mehr zum Angebot') takes the folded actions; exactly one '…'", async () => {
  await withPage(390, true, async (page) => {
    expect([await dots(page, head("named")), await page.locator(`${head("named")} .k2-bar-fold`).count()]).toEqual([1, 0]);
    const kept = (await seen(page, head("named"))).map((control) => control.name).filter((name) => actions.includes(name));
    expect(kept.length).toBeLessThan(actions.length);
    await page.locator(head("named")).getByRole("button", { name: "Mehr zum Angebot" }).click();
    const entries = await page.locator(".k2-menu").last().locator("[role^='menuitem']").allTextContents();
    // the fixture's four actions: those without room, then the menu's own
    expect(entries.map((entry) => entry.trim())).toEqual([...actions.slice(kept.length, 4), "Umbenennen"]);
  });
});

test("390 px: a menu with a symbol of its own after the '…' ('Ansicht') never folds; the '…' takes the actions, exactly one '…'", async () => {
  await withPage(390, true, async (page) => {
    expect([await dots(page, head("view")), await page.locator(`${head("view")} .k2-bar-fold`).count()]).toEqual([1, 0]);
    const names = (await seen(page, head("view"))).map((control) => control.name);
    expect(names.at(-1)).toBe("Ansicht");
    const kept = names.filter((name) => actions.includes(name));
    await page.locator(head("view")).getByRole("button", { name: more }).click();
    const entries = await page.locator(".k2-menu").last().locator("[role^='menuitem']").allTextContents();
    expect(entries.map((entry) => entry.trim())).toEqual([...actions.slice(kept.length, 4), "Umbenennen"]);
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
    expect(after.map((control) => control.name)).toEqual([...tabs, ...actions, "Neu"]);
    expect(after).toEqual(before);
  });
});

test("every 8 px from 320 to 1440: each end ends inside its bar's content edge, beside its start, and cuts no button", async () => {
  await withPage(320, true, async (page) => {
    const wrong: string[] = [];
    for (let width = 320; width <= 1440; width += 8) {
      await page.setViewportSize({ width, height: 1000 });
      await settled(page);
      for (const which of ["record", "book", "menu", "before", "long", "closes", "changes", "history", "reader", "tabs"]) {
        const { start, end, content } = await edges(page, head(which));
        if (!end) continue;
        if (end.right > content + 0.5) wrong.push(`${which} at ${width}: the end ends ${Math.round(end.right - content)} px beyond`);
        if (start && start.right > end.left + 0.5) wrong.push(`${which} at ${width}: the start runs under the end`);
        // A button the end cuts is half of one; that is the decided case only where the start stands at its least
        // (`--k2-start-least`) and nothing is left to fold.
        const cut = await page.evaluate((bar) => {
          const element = document.querySelector(bar)!;
          const endBox = element.querySelector(":scope > .k2-bar-end")!.getBoundingClientRect();
          const start = element.querySelector<HTMLElement>(":scope > .k2-bar-start");
          const probe = document.createElement("span");
          probe.style.cssText = "position:absolute;visibility:hidden;width:var(--k2-start-least)";
          start?.append(probe);
          const least = probe.getBoundingClientRect().width;
          probe.remove();
          const atLeast = start ? start.getBoundingClientRect().width <= least + 1 : false;
          const clipped = [...element.querySelectorAll<HTMLElement>(":scope > .k2-bar-end .k2-btn")]
            .filter((button) => button.checkVisibility())
            .some((button) => {
              const box = button.getBoundingClientRect();
              return box.left < endBox.left - 0.5 || box.right > endBox.right + 0.5;
            });
          return clipped && !atLeast;
        }, head(which));
        if (cut) wrong.push(`${which} at ${width}: the end cuts a button while its start is above its least`);
      }
    }
    expect(wrong).toEqual([]);
  });
}, 90_000);
