import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launchBrowser } from "../../../ui/test/browser";
import { layoutProblems } from "../../../ui/test/head-overlap";
import { installFlatWorkspaceHarness, openFlatWorkspace } from "../../test/flat-workspace.browser-harness";

installFlatWorkspaceHarness(launchBrowser);

// `GRIDS_FLAT_SHOTS=<dir>` also saves light screenshots of the invented records page for review.
const shots = process.env.GRIDS_FLAT_SHOTS;
const shotCases = (process.env.GRIDS_FLAT_CASES ?? "table=?rows=15")
  .split(",")
  .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)] as const);
const shotWidths = (process.env.GRIDS_FLAT_WIDTHS ?? "1440").split(",").map(Number);

test.if(Boolean(shots))(
  "saves screenshots of the invented records page",
  async () => {
    mkdirSync(shots!, { recursive: true });
    for (const [name, query] of shotCases)
      for (const width of shotWidths) {
        const theme = process.env.GRIDS_FLAT_THEME === "dark" ? "dark" : "light";
        const page = await openFlatWorkspace(width, `/app/grids${query}`, { fonts: true, theme });
        try {
          await page.screenshot({ path: resolve(shots!, `${name}-${width}.png`) });
        } finally {
          await page.context().close();
        }
      }
    expect(true).toBe(true);
  },
  120_000,
);

// K15 and "one line, one owner" (K2): the records page and its open detail draw no overlap, spill, cut text, double
// line, or sideways page at a laptop, a small laptop (1100 px), and a phone, with classic scrollbars, with few records
// (no scrollbar) and many (with one). Head and body cells of the table stay in one column grid when the scrollbar
// appears ("a scrollbar moves nothing").
// A collapsed Section in the detail's titled group ("More about this record") draws its heading 8 px past the section
// in the shared @k2b/ui blocks (reported to their lane, 21.11.); that heading row belongs to the block, not to this page.
const ignore =
  ".k2b-app-workspace__resize, .k2b-app-workspace__head-heading, .k2b-app-workspace__head-primary-label, .k2b-sr-only, .k2b-detail-panel__group[data-titled='true'] > .k2b-section > .k2b-section__header, [data-layout-check='skip']";
for (const width of [1440, 1100, 390])
  for (const [name, query] of [
    ["few records", "?rows=4"],
    ["many records", "?rows=40"],
    ["many records beside the open detail", "?rows=40&selected=5"],
  ] as const)
    test(`${width} px, ${name}: nothing overlaps, spills, is cut, or draws a double line`, async () => {
      const page = await openFlatWorkspace(width, `/app/grids${query}`, { touch: false });
      try {
        const found = await page.evaluate(layoutProblems, { root: ".layout-content-main", ignore });
        expect(found.problems).toEqual([]);
      } finally {
        await page.context().close();
      }
    });

test("1440 px: the name column stays within 560 px, numbers stand right-aligned and whole, and the head carries the views", async () => {
  const page = await openFlatWorkspace(1440, "/app/grids?rows=15", { touch: false });
  try {
    const shape = await page.evaluate(() => {
      const head = (label: string) =>
        Array.from(document.querySelectorAll<HTMLElement>(".k2b-data-table th")).find((cell) => cell.textContent?.trim() === label);
      const column = (label: string) => {
        const header = head(label);
        const index = header ? Array.from(header.parentElement!.children).indexOf(header) : -1;
        return Array.from(document.querySelectorAll<HTMLElement>(".k2b-data-table tbody tr.k2b-data-table__row")).flatMap((row) => {
          const cell = row.children[index];
          return cell instanceof HTMLElement ? [cell] : [];
        });
      };
      const prices = column("Tagespreis").filter((cell) => cell.textContent?.trim());
      return {
        name: head("Bezeichnung")?.getBoundingClientRect().width ?? 0,
        priceAlign: prices.map((cell) => getComputedStyle(cell).textAlign),
        priceWhole: prices.every((cell) => {
          const content = (cell.firstElementChild as HTMLElement | null) ?? cell;
          return content.scrollWidth <= content.clientWidth + 1;
        }),
        tabs: Array.from(document.querySelectorAll(".k2b-app-workspace__head .k2b-view-tabs__item")).map((tab) => tab.textContent?.trim()),
        lead: document.querySelector(".k2b-status-row__lead")?.textContent?.trim(),
      };
    });
    expect(shape.name).toBeGreaterThanOrEqual(200);
    expect(shape.name).toBeLessThanOrEqual(560);
    expect(new Set(shape.priceAlign)).toEqual(new Set(["right"]));
    expect(shape.priceWhole).toBe(true);
    expect(shape.tabs).toEqual(["Alle Datensätze", "Im Verleih", "Prüfung fällig"]);
    expect(shape.lead).toMatch(/Datensätze/);
  } finally {
    await page.context().close();
  }
});
