import { expect, test } from "bun:test";
import { deriveNoteTitle } from "../lib/note-title";
import { materializeTemplate, templates } from "../templates";
import { outline, preview, welcomeOutline, welcomePreview } from "./templates";

test("a template's outline names every page it makes, in its order, with its parent, in the person's language", () => {
  for (const locale of ["en", "de"]) {
    for (const template of templates) {
      const pages = outline(template.id, locale);
      const notes = materializeTemplate(template, new Date(), locale).notes;
      expect(pages?.length).toBe(notes.length);
      expect(pages?.every((page) => page.title.length > 0)).toBe(true);
      // a child names the page it stands under, and that page comes before it
      for (const [index, page] of (pages ?? []).entries()) {
        if (page.parent === null) continue;
        expect(pages?.slice(0, index).some((earlier) => earlier.title === page.parent)).toBe(true);
      }
    }
  }
  expect(outline("no-such-template")).toBeNull();
});

test("a German outline reads in German", () => {
  const [first] = templates;
  const en = outline(first?.id ?? "", "en")?.map((page) => page.title);
  const de = outline(first?.id ?? "", "de")?.map((page) => page.title);
  expect(en?.length).toBeGreaterThan(0);
  expect(de).not.toEqual(en);
});

test("a blank notebook's outline is its welcome page", () => {
  const [page, ...more] = welcomeOutline();
  expect(more).toEqual([]);
  expect(page?.parent).toBeNull();
  expect(page?.title).toBe(deriveNoteTitle(page?.title ? `# ${page.title}` : ""));
  expect(page?.title.length).toBeGreaterThan(0);
});

// The start page's cards (W2): each shows what its template makes, from the template itself, in the person's language.
test("a template's preview is its first table with rows, three columns of three rows, in the person's language", () => {
  for (const locale of ["en", "de"]) {
    for (const template of templates) {
      const shown = preview(template.id, locale);
      expect(shown).not.toBeNull();
      if (!shown || !("table" in shown)) continue;
      expect(shown.table.columns.length).toBeGreaterThan(0);
      expect(shown.table.columns.length).toBeLessThanOrEqual(3);
      expect(shown.table.rows.length).toBeGreaterThan(0);
      expect(shown.table.rows.length).toBeLessThanOrEqual(3);
      // plain words: no Markdown and no table syntax left in a cell
      for (const cell of [...shown.table.columns, ...shown.table.rows.flat()]) expect(cell).not.toMatch(/[|*]|^-+$/);
    }
  }
  // the reading list shows its books; the recipes skip a table without rows and show the pantry
  expect(preview("reading-list", "de")).toEqual({
    table: {
      columns: ["Titel", "Autor", "Status"],
      rows: [
        ["The Creative Act", "Rick Rubin", "Reading"],
        ["Braiding Sweetgrass", "Robin Wall Kimmerer", "Want"],
        ["Four Thousand Weeks", "Oliver Burkeman", "Done"],
      ],
    },
  });
  const pantry = preview("recipe-collector", "de");
  expect(pantry && "table" in pantry ? [pantry.table.columns, pantry.table.rows[0]] : null).toEqual([
    ["Zutat", "Menge", "Einheit"],
    ["Camembert", "250", "g"],
  ]);
  expect(preview("no-such-template")).toBeNull();
});

test("a blank notebook's preview is its welcome page: its title and first line as plain words", () => {
  const shown = welcomePreview();
  expect(shown).toEqual({ page: { title: welcomeOutline()[0]?.title ?? "-", text: expect.any(String) } });
  if ("page" in shown) expect(shown.page.text).not.toMatch(/[*#]/);
});
