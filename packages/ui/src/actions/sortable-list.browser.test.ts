import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "sortable-list.fixture.ts");
// A single list, and a board of three columns whose lists share a group; "Erledigt" is sorted by title.
const source = `
import { createEffect, createSignal } from "solid-js";
import { createComponent, insert, render } from "solid-js/web";
import { dragStatus, LocaleProvider, SortableList, useSortableMoveMenu } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const [order, setOrder] = createSignal(["alpha", "beta", "gamma", "delta"].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })));
window.order = () => order().map((item) => item.id);
window.moves = [];
const TITLES = {
  o1: "Impressum prüfen", o2: "Startseite gegenlesen", o3: "Kontaktformular testen", o4: "Bilder auswählen",
  o5: "Adressen sammeln", o6: "Fotos sichten", o7: "Texte kürzen", o8: "Links prüfen",
  d1: "Navigation festlegen", d2: "Produktseiten umziehen", d3: "Farben übernehmen",
  x1: "Abnahme vorbereiten", x2: "Zielgruppen festhalten",
};
const NAMES = { open: "Offen", doing: "In Arbeit", done: "Erledigt" };
const [board, setBoard] = createSignal({ open: ["o1", "o2", "o3", "o4", "o5", "o6", "o7", "o8"], doing: ["d1", "d2", "d3"], done: ["x1", "x2"] });
window.board = () => board();
const moveCard = (key, index, move) => {
  window.lastMove = move;
  window.moves.push([key, index, move.from, move.to]);
  const next = { ...board() };
  next[move.from] = next[move.from].filter((other) => other !== key);
  const to = next[move.to].filter((other) => other !== key);
  to.splice(index, 0, key);
  next[move.to] = to;
  setBoard(next);
};
const byTitle = (key) => board().done.filter((other) => other !== key && TITLES[other].localeCompare(TITLES[key]) < 0).length;
render(() => createComponent(LocaleProvider, { locale: window.LOCALE || "en", get children() {
  const moveMenu = useSortableMoveMenu("board");
  window.moveMenu = (key) => moveMenu(key);
  const status = document.createElement("p"); status.className = "status";
  createEffect(() => { const now = dragStatus(); status.textContent = now ? now.lead + " | " + now.detail : ""; });
  const single = document.createElement("div"); single.className = "single";
  insert(single, createComponent(SortableList, {
    get items() { return order(); },
    itemKey: (item) => item.id,
    itemLabel: (item) => item.name,
    label: "Pinned",
    onMove: (key, index) => {
      window.moves.push([key, index]);
      const next = order().filter((item) => item.id !== key);
      next.splice(index, 0, order().find((item) => item.id === key));
      // A host that saves gets newer copies of its items back; rows keep their elements and focus.
      setOrder(next.map((item) => ({ ...item })));
    },
    children: (item, handle) => {
      const row = document.createElement("div"); row.className = "row";
      const name = document.createElement("span"); name.className = "name";
      row.append(handle, name);
      queueMicrotask(() => { name.textContent = item().name; });
      return row;
    },
  }));
  const columns = document.createElement("div"); columns.className = "board";
  for (const column of ["open", "doing", "done"]) {
    const section = document.createElement("section"); section.className = "column"; section.dataset.sortableColumn = ""; section.dataset.column = column;
    const head = document.createElement("div"); head.className = "head"; head.dataset.sortableColumnHead = ""; head.textContent = NAMES[column];
    const scroll = document.createElement("div"); scroll.className = "scroll";
    insert(scroll, createComponent(SortableList, {
      get items() { return board()[column]; },
      itemKey: (key) => key,
      itemLabel: (key) => TITLES[key],
      label: NAMES[column],
      group: "board",
      listKey: column,
      dragBy: "row",
      placement: column === "done" ? byTitle : undefined,
      onMove: moveCard,
      children: (key, handle) => {
        const card = document.createElement("div"); card.className = "card"; card.dataset.card = key();
        const title = document.createElement("span"); title.className = "title"; title.textContent = TITLES[key()];
        card.append(handle, title);
        return card;
      },
    }));
    section.append(head, scroll);
    columns.append(section);
  }
  return [status, single, columns];
} }), document.getElementById("app"));
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: source },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the sortable list fixture.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async ({ width = 1100, locale = "en" }: { width?: number; locale?: string } = {}) => {
  const context = await browser.newContext({ viewport: { width, height: 720 } });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html lang="${locale}"><head><style>${css}</style><style>
    body { margin: 0; font: 13px/20px system-ui, sans-serif; } #app { display: grid; grid-template-columns: 280px 1fr; grid-template-rows: auto 1fr; gap: 0 20px; padding: 20px; }
    .status { grid-column: 1 / -1; height: 20px; margin: 0 0 12px; }
    .row { display: flex; align-items: center; gap: 8px; height: 44px; padding-inline: 4px; }
    .board { display: flex; min-width: 0; --k2b-sortable-gap: 0px; }
    .column { width: 240px; flex: none; border-inline-end: 1px solid #e4e4e7; }
    .head { height: 36px; display: flex; align-items: center; padding: 0 12px; font-weight: 600; border-bottom: 1px solid #e4e4e7; }
    .scroll { max-height: 290px; overflow: auto; }
    @media (max-width: 600px) { #app { grid-template-columns: 1fr; } .single { margin-bottom: 20px; } }
    .card { display: flex; align-items: center; gap: 8px; min-height: 56px; padding: 0 12px 0 4px; border-bottom: 1px solid #e4e4e7; box-sizing: border-box; }
    </style><script>window.LOCALE = ${JSON.stringify(locale)};</script></head><body class="k2b-ui"><div id="app"></div></body></html>`);
  await page.addScriptTag({ content: script });
  await page.locator('[data-card="o1"]').waitFor();
  return { page, context };
};
type Board = Record<"open" | "doing" | "done", string[]>;
const order = (page: Page) => page.evaluate(() => (window as unknown as { order: () => string[] }).order());
const board = (page: Page) => page.evaluate(() => (window as unknown as { board: () => Board }).board());
/** Every row of every list and every column head, so a test can tell that nothing moved. */
const boxes = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#app :is(.k2b-sortable-list__item, .head)")].map((item) => {
      const box = item.getBoundingClientRect();
      return [item.textContent, box.x, box.y, box.width, box.height].join(" ");
    }),
  );
const center = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
/** Where the line is: the row that carries it and on which side, or "empty" for an empty list. */
const line = (page: Page) =>
  page.evaluate(() => {
    const marked = document.querySelector<HTMLElement>("[data-sortable-line]");
    if (!marked) return undefined;
    const row = marked.querySelector("[data-card], .row");
    return `${marked.dataset.sortableLine} ${row?.getAttribute("data-card") ?? row?.textContent ?? ""}`.trim();
  });
const status = (page: Page) => page.locator(".status").textContent();
const announced = (page: Page, text: string) =>
  page.waitForFunction((text) => document.querySelector(".k2b-drag-announcer")?.textContent?.includes(text), text, { timeout: 4000 });
/** Presses a card on its title and moves far enough to start the drag. */
const lift = async (page: Page, card: string) => {
  const point = await center(page, `[data-card="${card}"] .title`);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 4, point.y + 14);
  await page.locator(".k2b-drag-preview").waitFor();
  return point;
};

describe(`sortable list in ${browserName}`, () => {
  test("a row dragged by its grip lands where the line shows; the preview hangs below the line and nothing moves", async () => {
    const { page, context } = await open();
    try {
      const before = await boxes(page);
      const grip = await center(page, '[data-sortable-handle="alpha"]');
      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      await page.mouse.move(grip.x + 4, grip.y + 15);
      await page.locator(".k2b-drag-preview").waitFor();
      // Into the upper part of Delta: the line sits above the row under the pointer.
      const delta = await center(page, ".single .k2b-sortable-list__item >> nth=3");
      const pointer = { x: delta.x, y: delta.y - 10 };
      for (const step of [0.5, 1]) await page.mouse.move(pointer.x, grip.y + (pointer.y - grip.y) * step);
      await page.waitForFunction(() => document.querySelector("[data-sortable-line]") !== null);
      await settled(page);
      expect(await line(page)).toBe("before Delta");
      const during = await page.evaluate(() => {
        const marked = document.querySelector("[data-sortable-line]")!;
        const lineStyle = getComputedStyle(marked, "::before");
        const preview = document.querySelector<HTMLElement>(".k2b-drag-preview")!;
        return {
          line: [lineStyle.content, lineStyle.height],
          lineBottom: marked.getBoundingClientRect().top + 1,
          previewTop: preview.getBoundingClientRect().top,
          kind: preview.dataset.preview,
          copy: preview.textContent,
          dragged: document.querySelector("[data-sortable-dragging]")?.textContent,
          dim: getComputedStyle(document.querySelector("[data-sortable-dragging] .name")!).opacity,
        };
      });
      expect(during).toMatchObject({ line: ['""', "2px"], kind: "row", copy: "Alpha", dragged: "Alpha", dim: "0.4" });
      expect(during.previewTop).toBeGreaterThan(during.lineBottom);
      expect(during.previewTop).toBeGreaterThan(pointer.y);
      expect(await boxes(page)).toEqual(before);
      await page.mouse.up();
      await page.waitForFunction(
        () => !document.querySelector(".k2b-drag-preview, [data-drop], [data-sortable-dragging], [data-sortable-line]"),
      );
      expect(await order(page)).toEqual(["beta", "gamma", "alpha", "delta"]);
      // A press on the row's text is not a grip: it starts nothing.
      const name = await center(page, ".name >> nth=0");
      await page.mouse.move(name.x, name.y);
      await page.mouse.down();
      await page.mouse.move(name.x, name.y + 60, { steps: 4 });
      await page.mouse.up();
      expect(await page.locator(".k2b-drag-preview").count()).toBe(0);
      expect(await order(page)).toEqual(["beta", "gamma", "alpha", "delta"]);
    } finally {
      await context.close();
    }
  });

  test("a card moves to another column: the head is tinted, the status says where, no row anywhere moves, and undo returns it", async () => {
    const { page, context } = await open({ locale: "de" });
    try {
      const before = await boxes(page);
      await lift(page, "o2");
      // Still over its own place: no line, no tinted head, and the status says it stays.
      expect(await status(page)).toBe("„Startseite gegenlesen“ wird verschoben | bleibt an seinem Platz · Esc bricht ab");
      expect(await line(page)).toBeUndefined();
      expect(await page.locator("[data-sortable-target]").count()).toBe(0);
      const target = await center(page, '[data-card="d2"]');
      await page.mouse.move(target.x, target.y - 12, { steps: 3 });
      await page.waitForFunction(() => document.querySelector('[data-column="doing"][data-sortable-target]') !== null);
      await settled(page);
      expect(await line(page)).toBe("before d2");
      expect(await status(page)).toBe("„Startseite gegenlesen“ wird verschoben | nach „In Arbeit“, Platz 2 · Esc bricht ab");
      await announced(page, "Position 2 von 4 in „In Arbeit“.");
      const tint = await page.evaluate(() => {
        const head = (column: string) => getComputedStyle(document.querySelector(`[data-column="${column}"] .head`)!).backgroundColor;
        return { doing: head("doing"), open: head("open") };
      });
      expect(tint.doing).not.toBe(tint.open);
      expect(tint.open).toBe("rgba(0, 0, 0, 0)");
      // The row's content dims; its hairline and grip keep their strength.
      expect(
        await page
          .locator('#app [data-card="o2"]')
          .evaluate((card) => [
            getComputedStyle(card.querySelector(".title")!).opacity,
            getComputedStyle(card).opacity,
            getComputedStyle(card.closest("li")!).opacity,
          ]),
      ).toEqual(["0.4", "1", "1"]);
      expect(await boxes(page)).toEqual(before);
      await page.mouse.up();
      await page.waitForFunction(() => !document.querySelector(".k2b-drag-preview, [data-sortable-target], [data-sortable-line]"));
      expect(await board(page)).toMatchObject({ open: ["o1", "o3", "o4", "o5", "o6", "o7", "o8"], doing: ["d1", "o2", "d2", "d3"] });
      expect(await page.evaluate(() => (window as unknown as { moves: unknown[] }).moves.at(-1))).toEqual(["o2", 1, "open", "doing"]);
      expect(await status(page)).toBe("");
      // The host's toast calls undo; the card goes back to its place.
      await page.evaluate(() => (window as unknown as { lastMove: { undo: () => void } }).lastMove.undo());
      expect(await board(page)).toMatchObject({ open: ["o1", "o2", "o3", "o4", "o5", "o6", "o7", "o8"], doing: ["d1", "d2", "d3"] });
    } finally {
      await context.close();
    }
  });

  test("Escape, or letting go outside every column, puts the card back", async () => {
    const { page, context } = await open();
    try {
      const start = await board(page);
      await lift(page, "o1");
      const target = await center(page, '[data-card="d1"]');
      await page.mouse.move(target.x, target.y, { steps: 2 });
      await page.waitForFunction(() => document.querySelector("[data-sortable-line]") !== null);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector(".k2b-drag-preview, [data-sortable-line], [data-sortable-dragging]"));
      await page.mouse.up();
      expect(await board(page)).toEqual(start);
      // Outside the board there is no column, so the release cancels.
      await settled(page);
      await lift(page, "o1");
      await page.mouse.move(700, 680, { steps: 3 });
      await page.waitForFunction(() => !document.querySelector("[data-sortable-line]"));
      await page.mouse.up();
      await page.waitForFunction(() => !document.querySelector(".k2b-drag-preview"));
      expect(await board(page)).toEqual(start);
    } finally {
      await context.close();
    }
  });

  test("resting at a column's lower edge scrolls it, and the line follows the rows that come into view", async () => {
    const { page, context } = await open();
    try {
      await lift(page, "d1");
      const scroll = (await page.locator('[data-column="open"] .scroll').boundingBox())!;
      await page.mouse.move(scroll.x + scroll.width / 2, scroll.y + scroll.height - 6, { steps: 3 });
      await page.waitForFunction(() => document.querySelector('[data-column="open"] .scroll')!.scrollTop > 100, undefined, {
        timeout: 4000,
      });
      await page.mouse.up();
      await page.waitForFunction(() => !document.querySelector(".k2b-drag-preview"));
      const after = await board(page);
      // It landed below a row that was out of view when the drag began.
      expect(after.open.indexOf("d1")).toBeGreaterThan(4);
    } finally {
      await context.close();
    }
  });

  test("a sorted column shows the line where the card will land, wherever the pointer is", async () => {
    const { page, context } = await open();
    try {
      await lift(page, "o3");
      // The pointer rests on the first card of "Erledigt"; by title "Kontaktformular" lands second.
      const first = await center(page, '[data-card="x1"]');
      await page.mouse.move(first.x, first.y - 20, { steps: 3 });
      await page.waitForFunction(() => document.querySelector("[data-sortable-line]") !== null);
      expect(await line(page)).toBe("before x2");
      await settled(page);
      // The line is below the pointer here; the preview hangs below the line, never over it, and stays in the viewport.
      const geometry = await page.evaluate(() => {
        const preview = document.querySelector(".k2b-drag-preview")!.getBoundingClientRect();
        const marked = document.querySelector("[data-sortable-line]")!.getBoundingClientRect();
        return { previewTop: preview.top, lineBottom: marked.top + 4, right: preview.right, width: innerWidth };
      });
      expect(geometry.previewTop).toBeGreaterThan(geometry.lineBottom);
      expect(geometry.right).toBeLessThanOrEqual(geometry.width);
      await page.mouse.up();
      await page.waitForFunction(() => !document.querySelector(".k2b-drag-preview"));
      expect((await board(page)).done).toEqual(["x1", "o3", "x2"]);
    } finally {
      await context.close();
    }
  });

  test("Space lifts, arrows choose a place across columns while nothing moves, Enter drops, Escape cancels", async () => {
    const { page, context } = await open({ locale: "de" });
    try {
      const before = await boxes(page);
      await page.locator('[data-sortable-handle="o1"]').focus();
      await page.keyboard.press("Space");
      await announced(page, "Impressum prüfen angehoben. Position 1 von 8 in „Offen“.");
      await page.keyboard.press("ArrowDown");
      expect(await line(page)).toBe("before o3");
      await page.keyboard.press("ArrowRight");
      expect(await line(page)).toBe("before d2");
      await announced(page, "Position 2 von 4 in „In Arbeit“.");
      expect(await status(page)).toBe("„Impressum prüfen“ wird verschoben | nach „In Arbeit“, Platz 2 · Enter legt ab, Esc bricht ab");
      // The lifted grip and every box around it stay at full strength, so its focus ring keeps its contrast.
      expect(
        await page.locator('[data-sortable-handle="o1"]').evaluate((grip) => {
          const seen: string[] = [];
          for (let element: Element | null = grip; element && element.tagName !== "UL"; element = element.parentElement)
            seen.push(getComputedStyle(element).opacity);
          return seen.every((value) => value === "1");
        }),
      ).toBe(true);
      expect(await page.locator('[data-column="doing"]').getAttribute("data-sortable-target")).toBe("");
      await settled(page);
      expect(await boxes(page)).toEqual(before);
      await page.keyboard.press("Enter");
      await announced(page, "Impressum prüfen abgelegt, Position 2 von 4 in „In Arbeit“.");
      expect((await board(page)).doing).toEqual(["d1", "o1", "d2", "d3"]);
      await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset.sortableHandle === "o1");
      expect(await page.evaluate(() => document.activeElement!.closest("[data-column]")!.getAttribute("data-column"))).toBe("doing");
      // Lifted again, Escape leaves it where it is.
      await page.keyboard.press("Space");
      await page.keyboard.press("ArrowLeft");
      expect(await line(page)).toBe("before o3");
      await page.keyboard.press("Escape");
      await announced(page, "Abgebrochen. Impressum prüfen bleibt an seinem Platz.");
      expect(await line(page)).toBeUndefined();
      expect((await board(page)).doing).toEqual(["d1", "o1", "d2", "d3"]);
      expect(await status(page)).toBe("");
    } finally {
      await context.close();
    }
  });

  test("the grip's arrow keys alone move one step, keep focus, and say where it is", async () => {
    const { page, context } = await open();
    try {
      await page.locator('[data-sortable-handle="delta"]').focus();
      await page.keyboard.press("ArrowUp");
      expect(await order(page)).toEqual(["alpha", "beta", "delta", "gamma"]);
      await page.keyboard.press("Home");
      expect(await order(page)).toEqual(["delta", "alpha", "beta", "gamma"]);
      // The first row cannot move further up; nothing happens.
      await page.keyboard.press("ArrowUp");
      expect(await order(page)).toEqual(["delta", "alpha", "beta", "gamma"]);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-sortable-handle"))).toBe("delta");
      await announced(page, "Delta, position 1 of 4.");
      await page.keyboard.press("End");
      expect(await order(page)).toEqual(["alpha", "beta", "gamma", "delta"]);
      await settled(page);
      const handle = await page.locator('[data-sortable-handle="delta"]').evaluate((element) => ({
        name: element.getAttribute("aria-label"),
        hint: document.getElementById(element.getAttribute("aria-describedby")!)?.textContent,
        outline: getComputedStyle(element).outlineStyle,
      }));
      expect(handle).toEqual({
        name: "Move Delta",
        hint: "Drag, or press Space, then the arrow keys and Enter. The arrow keys alone move one step.",
        outline: "solid",
      });
    } finally {
      await context.close();
    }
  });

  test("on a phone a board card does not drag; the move menu moves it, and a single list still drags by its grip", async () => {
    const { page, context } = await open({ width: 390 });
    try {
      const card = await center(page, '[data-card="o1"] .title');
      await page.mouse.move(card.x, card.y);
      await page.mouse.down();
      await page.mouse.move(card.x, card.y + 40, { steps: 4 });
      await page.mouse.up();
      expect(await page.locator(".k2b-drag-preview").count()).toBe(0);
      const section = await page.evaluate(() => {
        const menu = (
          window as unknown as { moveMenu: (key: string) => { sectionLabel: string; items: { label: string; action: () => void }[] } }
        ).moveMenu("o1");
        const labels = menu.items.map((item) => item.label);
        menu.items[0]!.action();
        return { title: menu.sectionLabel, labels };
      });
      expect(section).toEqual({ title: "Move to", labels: ["In Arbeit", "Erledigt"] });
      expect((await board(page)).doing).toEqual(["d1", "d2", "d3", "o1"]);
      await settled(page);
      const grip = await center(page, '[data-sortable-handle="alpha"]');
      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      await page.mouse.move(grip.x + 4, grip.y + 15);
      await page.locator(".k2b-drag-preview").waitFor();
      await page.keyboard.press("Escape");
      await page.mouse.up();
    } finally {
      await context.close();
    }
  });
});
