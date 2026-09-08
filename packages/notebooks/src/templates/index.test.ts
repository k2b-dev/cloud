import { describe, expect, test } from "bun:test";
import { renderNotebookBook } from "../lib/book-renderer";
import { extractNamedDataProperties } from "../lib/named-blocks";
import { deriveNoteTitle } from "../lib/note-title";
import { parseNotebookQueryBlocks, parseNotebookTocBlocks } from "../lib/query-blocks";
import type { NoteQueryResult } from "../service/note-query";
import type { Notebook } from "../service/notebooks";
import type { Note } from "../service/notes";
import { materializeTemplate, type TemplateNoteContentContext, templates } from ".";

const assertUnique = (values: string[], label: string) => {
  expect(new Set(values).size, `${label} must be unique`).toBe(values.length);
};

const fakeNotebook: Notebook = {
  id: "00000000-0000-0000-0000-000000000001",
  shortId: "abc123",
  name: "Template test",
  description: null,
  icon: null,
  homepageNoteId: null,
  homepageNoteShortId: null,
  defaultPresentationMode: "write",
  defaultNoteTitleTemplate: "New Document",
  createdBy: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const fakeNote = (title: string, shortId: string, parentId: string | null): Note => ({
  id: `00000000-0000-0000-0000-${shortId.padStart(12, "0").slice(0, 12)}`,
  shortId,
  notebookId: fakeNotebook.id,
  parentId,
  title,
  position: 0,
  hasChildren: false,
  historyIncomplete: false,
  yjsSnapshotAt: null,
  contentMd: null,
  createdBy: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  lockedAt: null,
});

const resolveContents = (locale: string) => {
  const now = new Date(2031, 6, 14, 9, 30);
  return templates.map((template) => {
    const materialized = materializeTemplate(template, now, locale);
    const notes = new Map<string, Note>();
    for (const [index, note] of materialized.notes.entries()) {
      const parent = note.parentKey ? notes.get(note.parentKey) : null;
      notes.set(note.key, fakeNote("Neue Notiz", `n${String(index).padStart(5, "0")}`, parent?.id ?? null));
    }
    const ctx: TemplateNoteContentContext = {
      now,
      locale,
      notebook: fakeNotebook,
      notes,
      link: (key, label) => {
        const note = notes.get(key);
        if (!note) throw new Error(`missing note ${key}`);
        return `[${label}](note://${note.shortId})`;
      },
      noteId: (key) => {
        const note = notes.get(key);
        if (!note) throw new Error(`missing note ${key}`);
        return note.shortId;
      },
    };
    return {
      template: materialized,
      contents: materialized.notes.map((note) => (typeof note.content === "function" ? note.content(ctx) : (note.content ?? ""))),
    };
  });
};

describe("built-in notebook templates", () => {
  test("keeps template identities and small linked starter trees", () => {
    expect(templates.map((template) => template.id)).toEqual(["daily-notes", "garden-planner", "recipe-collector", "reading-list"]);
    for (const { template, contents } of resolveContents("en")) {
      assertUnique(
        template.notes.map((note) => note.key),
        template.id,
      );
      expect(template.notes.length).toBeGreaterThanOrEqual(2);
      expect(template.notes.length).toBeLessThanOrEqual(6);
      const keys = new Set(template.notes.map((note) => note.key));
      expect(template.homepageNoteKey).toBeTruthy();
      expect(keys.has(template.homepageNoteKey!)).toBe(true);
      for (const note of template.notes) {
        if (note.parentKey) expect(keys.has(note.parentKey)).toBe(true);
      }
      for (const content of contents) expect(deriveNoteTitle(content).length).toBeGreaterThan(0);
    }
  });

  test("uses the instantiation year dynamically", () => {
    const materialized = materializeTemplate(templates.find((template) => template.id === "daily-notes")!, new Date(2031, 0, 5));
    const titles = materialized.notes.map((note) => (typeof note.content === "string" ? deriveNoteTitle(note.content) : null));
    expect(titles).toContain("2031");
    expect(titles).not.toContain("2026");
  });

  test("resolves complete German content and preserves tree and query contracts", () => {
    const english = resolveContents("en");
    const german = resolveContents("de-CH");
    expect(german.map(({ template }) => template.name)).toEqual(["Tagebuch", "Gartentagebuch", "Rezepte und Vorräte", "Leseliste"]);
    const germanText = german.flatMap(({ contents }) => contents).join("\n");
    expect(germanText).toContain("Beginne hier");
    expect(germanText).toContain("So verwendest du dieses Gartentagebuch");
    expect(germanText).toContain("Käsespätzle mit Röstzwiebeln");
    expect(germanText).toContain("Aufmerksamkeit wird als Praxis verstanden");
    expect(germanText).not.toMatch(/Start here|How to use|Monthly focus|Year notes|Recipe schema/);
    for (const [index, en] of english.entries()) {
      const de = german[index]!;
      expect(de.template.id).toBe(en.template.id);
      expect(de.template.homepageNoteKey).toBe(en.template.homepageNoteKey);
      expect(de.template.notes.map(({ key, parentKey }) => [key, parentKey])).toEqual(
        en.template.notes.map(({ key, parentKey }) => [key, parentKey]),
      );
      const queries = (contents: string[]) =>
        contents.flatMap((source) => parseNotebookQueryBlocks(source).blocks).map(({ line, ...query }) => query);
      expect(queries(de.contents)).toEqual(queries(en.contents));
    }
  });

  for (const locale of ["en", "de-CH"]) {
    test(`${locale} templates parse and render through the canonical renderer without scripting`, () => {
      for (const { template, contents } of resolveContents(locale)) {
        let queryCount = 0;
        for (const markdown of contents) {
          expect(markdown).not.toMatch(/\`\`\`script|\b(?:ui|nb|current)\./);
          const data = extractNamedDataProperties(markdown);
          expect(data.diagnostics, template.id).toEqual([]);
          const queries = parseNotebookQueryBlocks(markdown);
          const toc = parseNotebookTocBlocks(markdown);
          expect(queries.diagnostics, template.id).toEqual([]);
          expect(toc.diagnostics, template.id).toEqual([]);
          queryCount += queries.blocks.length;
          const queryResults = new Map<number, NoteQueryResult>(
            queries.blocks.map((query) => [
              query.line,
              {
                columns: query.columns.length ? query.columns : ["$title"],
                items: [],
                total: 0,
                limit: query.limit,
                truncated: false,
                diagnostics: [],
              },
            ]),
          );
          const rendered = renderNotebookBook({ markdown, notebookId: fakeNotebook.shortId, locale, queryResults });
          expect(rendered.html).toContain("<h1");
          expect(rendered.html).not.toContain("data-script-source");
          expect(rendered.html).not.toContain("<script");
          expect(rendered.blocks.length).toBe(queries.blocks.length + toc.blocks.length);
          for (const block of rendered.blocks) expect(rendered.html).toContain(block.html);
        }
        expect(queryCount, template.id).toBeGreaterThan(0);
      }
    });
  }
});
