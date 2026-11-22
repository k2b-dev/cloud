import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright";
import { layoutProblems } from "../../../../../../ui/test/head-overlap";
import { type Harness, startHarness, type View } from "./spaces-flat.browser-harness";

let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
}, 120_000);
afterAll(async () => {
  await harness?.stop();
});

/** Waits until `read` returns `expected`; a browser test checks state the page reaches a moment later. */
const until = async <T>(read: () => T, expected: Awaited<T>, timeout = 4000) => {
  const end = performance.now() + timeout;
  let value: Awaited<T> = await read();
  while (!Bun.deepEquals(value, expected) && performance.now() < end) {
    await Bun.sleep(50);
    value = await read();
  }
  expect(value).toEqual(expected);
};

/**
 * Avatar stacks overlap on purpose; text for screen readers is cut on purpose. The head's primary label belongs to the
 * shell (L3), which hides it on a phone. Touch hit areas are known to the self-check itself (#3923).
 */
const ignored = ".k2b-avatar-stack, [data-layout-check='skip'], .sr-only, .k2b-sr-only, .k2b-app-workspace__head-primary-label";

const desktop: View = { width: 1440, height: 900, touch: false };
const phone: View = { width: 390, height: 844, touch: true };
const views = [desktop, phone];
const card = (page: Page, title: string) => page.locator("[data-sortable-column] li", { hasText: title });
const boxOf = (page: Page, title: string) => card(page, title).boundingBox();

// K15 and "one line, one owner": nothing overlaps, spills, is cut, or draws a double line, with few tasks (no
// scrollbar) and with many (every column and the list scroll).
for (const view of views)
  for (const name of ["list", "kanban"] as const)
    for (const many of [false, true])
      test(`${view.width} px ${name}, ${many ? "many tasks" : "few tasks"}: no overlap, spill, cut, double line, or scrollbar break`, async () => {
        const page = await harness.open(view, { view: name, many });
        try {
          const result = await page.evaluate(layoutProblems, { root: "body", ignore: ignored });
          expect(result.problems).toEqual([]);
        } finally {
          await page.context().close();
        }
      }, 30_000);

test("1440 px kanban: a card is a row of its column, 56 px with one title line, without frame, tint, or shadow", async () => {
  const page = await harness.open(desktop, { view: "kanban" });
  try {
    const look = await card(page, "Startseite: Texte gegenlesen")
      .locator("article")
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          // The row is 56 px with its line (K1); the line belongs to the list item around the card.
          height: Math.round(element.closest("li")!.getBoundingClientRect().height),
          radius: style.borderTopLeftRadius,
          shadow: style.boxShadow,
          border: style.borderTopWidth,
          // Every line of the card is 20 px (K1); a taller part names itself here.
          tall: [...element.querySelectorAll<HTMLElement>(".spaces-kanban-card__meta *, .spaces-kanban-card__people *")]
            .filter((part) => part.getBoundingClientRect().height > 20.5 && part.checkVisibility())
            .map((part) => `${part.className} ${Math.round(part.getBoundingClientRect().height)}`),
          // A held finger shows on the card itself, not only behind it (K7).
          held: (() => {
            const source = element.closest<HTMLElement>(".k2b-drag-source")!;
            const rest = getComputedStyle(element).backgroundColor;
            source.dataset.held = "";
            const colours = [getComputedStyle(element).backgroundColor, getComputedStyle(source).backgroundColor];
            delete source.dataset.held;
            return colours[0] !== rest && colours[0] === colours[1];
          })(),
        };
      });
    expect(look).toEqual({ height: 56, radius: "0px", shadow: "none", border: "0px", tall: [], held: true });
  } finally {
    await page.context().close();
  }
}, 30_000);

test("1440 px kanban: a dragged card stays in place, nothing moves before the drop, Esc puts it back and saves nothing", async () => {
  const page = await harness.open(desktop, { view: "kanban" });
  try {
    const before = harness.moves.length;
    const neighbour = await boxOf(page, "Produktseiten umziehen");
    const from = (await boxOf(page, "Startseite: Texte gegenlesen"))!;
    await page.mouse.move(from.x + 60, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(from.x + 70, from.y + 24, { steps: 3 });
    await page.mouse.move(neighbour!.x + 80, neighbour!.y + 6, { steps: 12 });
    await until(() => targetColumn(page), "column:Col002");
    // settled: the drag holds the pointer; that no row moved while it does is the subject.
    expect(await boxOf(page, "Produktseiten umziehen")).toEqual(neighbour);
    // settled: as above, the dragged card keeps its place until the drop.
    expect(await boxOf(page, "Startseite: Texte gegenlesen")).toEqual(from);
    expect(await page.evaluate(() => document.querySelector(".k2b-status-row")?.textContent ?? "")).toContain("In Arbeit");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await until(() => page.locator("[data-sortable-target]").count(), 0);
    expect(harness.moves.length).toBe(before);
  } finally {
    await page.context().close();
  }
}, 30_000);

test("1440 px kanban: a dropped card lands where the line showed at once, saves once, and Undo puts it back", async () => {
  const page = await harness.open(desktop, { view: "kanban" });
  try {
    const before = harness.moves.length;
    // The save answers only once the card stands in its new place: the board must not wait for it.
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    await page.route("**/move", async (route) => {
      await answered;
      await route.continue();
    });
    // A page-wide view transition would hold the old picture and fade the whole page on every drop.
    await page.evaluate(() => {
      const counted = window as Window & { transitions?: number };
      counted.transitions = 0;
      const start = document.startViewTransition?.bind(document);
      if (start)
        document.startViewTransition = (update) => {
          counted.transitions = (counted.transitions ?? 0) + 1;
          return start(update);
        };
    });
    const neighbour = (await boxOf(page, "Produktseiten umziehen"))!;
    const from = (await boxOf(page, "Startseite: Texte gegenlesen"))!;
    await page.mouse.move(from.x + 60, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(from.x + 70, from.y + 24, { steps: 3 });
    await page.mouse.move(neighbour.x + 80, neighbour.y + 6, { steps: 12 });
    await page.mouse.up();
    const lane = page.locator('[data-spaces-kanban-column="column:Col002"] li');
    await until(async () => (await lane.nth(1).innerText()).includes("Startseite: Texte gegenlesen"), true);
    expect(harness.moves.length).toBe(before);
    answer();
    await until(() => harness.moves.length, before + 1);
    expect(await page.evaluate(() => (window as Window & { transitions?: number }).transitions)).toBe(0);
    expect(harness.moves.at(-1)).toEqual({ itemId: "Item02", body: { columnId: "Col002", afterItemId: "Item06" } });
    await page.getByRole("button", { name: "Rückgängig" }).click();
    await until(() => harness.moves.length, before + 2);
    expect(harness.moves.at(-1)).toEqual({ itemId: "Item02", body: { columnId: "Col001", afterItemId: "Item01" } });
  } finally {
    await page.context().close();
  }
}, 30_000);

test("390 px kanban: a card does not drag on a phone, and its menu moves it to another column", async () => {
  const page = await harness.open(phone, { view: "kanban" });
  try {
    const before = harness.moves.length;
    await page.getByRole("button", { name: "Aktionen für Startseite: Texte gegenlesen" }).click();
    await page.getByRole("menuitem", { name: "Verschieben nach" }).click();
    await page.getByRole("menuitem", { name: "Prüfung" }).click();
    await until(() => harness.moves.length, before + 1);
    expect(harness.moves.at(-1)?.body).toMatchObject({ columnId: "Col003" });
  } finally {
    await page.context().close();
  }
}, 30_000);

/** The column a moved card would land in now, without waiting for one to exist. */
const targetColumn = (page: Page) =>
  page.evaluate(() => document.querySelector("[data-sortable-target]")?.getAttribute("data-spaces-kanban-column") ?? null);
const grip = (page: Page, itemId: string) => page.locator(`[data-sortable-handle="${itemId}"]`);
const focusedHandle = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("data-sortable-handle") ?? null);

test("keyboard: Space lifts a card, the arrows choose the next column and place 2, Enter drops, and the grip keeps the focus", async () => {
  const page = await harness.open(desktop, { view: "kanban" });
  try {
    const before = harness.moves.length;
    await grip(page, "Item02").focus();
    await page.keyboard.press("Space");
    await until(() => page.evaluate(() => document.querySelector(".k2b-status-row")?.textContent?.includes("Startseite") ?? false), true);
    // The lift keeps its place 2 in the next column.
    await page.keyboard.press("ArrowRight");
    await until(() => targetColumn(page), "column:Col002");
    // Nothing moves until the drop.
    expect(harness.moves.length).toBe(before);
    await page.keyboard.press("Enter");
    await until(() => harness.moves.length, before + 1);
    expect(harness.moves.at(-1)).toEqual({ itemId: "Item02", body: { columnId: "Col002", afterItemId: "Item06" } });
    await until(() => focusedHandle(page), "Item02");
  } finally {
    await page.context().close();
  }
}, 30_000);

test("keyboard: Escape calls a lift off and saves nothing; the arrows pass an automatic column", async () => {
  const page = await harness.open(desktop, { view: "kanban", automatic: true });
  try {
    const before = harness.moves.length;
    await grip(page, "Item02").focus();
    await page.keyboard.press("Space");
    // The lift starts once the engine's keyboard module has loaded.
    await page.waitForSelector("[data-sortable-dragging]");
    await page.keyboard.press("ArrowRight");
    // Blocked lies between Offen and In Arbeit; it takes no card from elsewhere, so the lift skips it.
    await until(() => targetColumn(page), "column:Col002");
    await page.keyboard.press("Escape");
    await until(() => page.locator("[data-sortable-target]").count(), 0);
    expect(harness.moves.length).toBe(before);
    expect(await focusedHandle(page)).toBe("Item02");
  } finally {
    await page.context().close();
  }
}, 30_000);

test("1440 px kanban: an automatic column refuses a dragged card from elsewhere and says so in its head", async () => {
  const page = await harness.open(desktop, { view: "kanban", automatic: true });
  try {
    const before = harness.moves.length;
    const from = (await boxOf(page, "Startseite: Texte gegenlesen"))!;
    const blocked = (await page.locator('[data-spaces-kanban-column="virtual:blocked"]').boundingBox())!;
    await page.mouse.move(from.x + 60, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(from.x + 70, from.y + 24, { steps: 3 });
    await page.mouse.move(blocked.x + 80, blocked.y + 120, { steps: 12 });
    await until(() => page.locator('[data-spaces-kanban-column="virtual:blocked"][data-spaces-kanban-no-drop]').count(), 1);
    expect(await page.locator('[data-spaces-kanban-column="virtual:blocked"][data-sortable-target]').count()).toBe(0);
    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(harness.moves.length).toBe(before);
  } finally {
    await page.context().close();
  }
}, 30_000);

test("1440 px kanban: a card dropped on a folded column goes to the top of that column", async () => {
  const page = await harness.open(desktop, { view: "kanban", folded: ["column:Col003"] });
  try {
    const before = harness.moves.length;
    const from = (await boxOf(page, "Startseite: Texte gegenlesen"))!;
    const strip = (await page.locator('[data-spaces-kanban-fold="column:Col003"]').boundingBox())!;
    await page.mouse.move(from.x + 60, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(from.x + 70, from.y + 24, { steps: 3 });
    await page.mouse.move(strip.x + strip.width / 2, strip.y + 200, { steps: 14 });
    await until(() => page.locator('[data-spaces-kanban-column="column:Col003"][data-sortable-target]').count(), 1);
    await page.mouse.up();
    await until(() => harness.moves.length, before + 1);
    expect(harness.moves.at(-1)).toEqual({ itemId: "Item02", body: { columnId: "Col003" } });
  } finally {
    await page.context().close();
  }
}, 30_000);

test("keyboard: the arrows on a card's grip walk to the next card and move nothing until Space lifts it", async () => {
  const page = await harness.open(desktop, { view: "kanban" });
  try {
    const before = harness.moves.length;
    await grip(page, "Item02").focus();
    await page.keyboard.press("ArrowDown");
    await until(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.itemId ?? null), "Item03");
    await page.waitForTimeout(200);
    expect(harness.moves.length).toBe(before);
  } finally {
    await page.context().close();
  }
}, 30_000);

test("1440 px kanban: a card dropped on the first card of another column lands at its top", async () => {
  const page = await harness.open(desktop, { view: "kanban" });
  try {
    const before = harness.moves.length;
    const from = (await boxOf(page, "Startseite: Texte gegenlesen"))!;
    const first = (await boxOf(page, "Navigation und Seitenstruktur festlegen"))!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 12; step++)
      await page.mouse.move(
        from.x + from.width / 2 + ((first.x - from.x) * step) / 12,
        from.y + from.height / 2 + ((first.y - from.y) * step) / 12,
      );
    await until(() => targetColumn(page), "column:Col002");
    await page.mouse.up();
    await until(() => harness.moves.length, before + 1);
    expect(harness.moves.at(-1)).toEqual({ itemId: "Item02", body: { columnId: "Col002", beforeItemId: "Item06" } });
  } finally {
    await page.context().close();
  }
}, 30_000);

test("1440 px kanban: a card dragged out of Blocked takes a new open status", async () => {
  const page = await harness.open(desktop, { view: "kanban", automatic: true });
  try {
    const before = harness.moves.length;
    const from = (await boxOf(page, "Kontaktformular testen"))!;
    const first = (await boxOf(page, "Navigation und Seitenstruktur festlegen"))!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 12; step++)
      await page.mouse.move(
        from.x + from.width / 2 + ((first.x + first.width / 2 - from.x - from.width / 2) * step) / 12,
        from.y + from.height / 2 + ((first.y + first.height / 2 - from.y - from.height / 2) * step) / 12,
      );
    await until(() => targetColumn(page), "column:Col002");
    await page.mouse.up();
    await until(() => harness.moves.length, before + 1);
    expect(harness.moves.at(-1)?.body).toMatchObject({ columnId: "Col002" });
  } finally {
    await page.context().close();
  }
}, 30_000);
