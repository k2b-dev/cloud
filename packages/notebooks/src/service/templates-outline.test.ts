import { expect, test } from "bun:test";
import { deriveNoteTitle } from "../lib/note-title";
import { materializeTemplate, templates } from "../templates";
import { outline, welcomeOutline } from "./templates";

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
