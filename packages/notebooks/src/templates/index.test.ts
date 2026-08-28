import { describe, expect, test } from "bun:test";
import { deriveNoteTitle } from "../lib/note-title";
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
  scriptsEnabled: false,
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

const scripts = (source: string) => [...source.matchAll(/```script\n([\s\S]*?)```/g)].map((match) => match[1] ?? "").join("\n");
const prose = (source: string) => source.replace(/```script\n[\s\S]*?```/g, "");
const references = (source: string) => [...source.matchAll(/^@(\w[\w.]*)$/gm)].map((match) => match[1]).sort();
const scriptSelectors = (source: string) =>
  [...source.matchAll(/\.(?:data|table|todo|list|section)\("([^"]+)"\)/g)].map((match) => match[1]).sort();

describe("built-in notebook templates", () => {
  test("template ids are unique", () => {
    assertUnique(
      templates.map((template) => template.id),
      "template ids",
    );
  });

  test("materialized notes have unique keys and resolvable content links", () => {
    const now = new Date(2031, 6, 14, 9, 30);

    for (const template of templates) {
      const materialized = materializeTemplate(template, now);
      assertUnique(
        materialized.notes.map((note) => note.key),
        `${template.id} note keys`,
      );
      expect(materialized.notes.length, `${template.id} must create real starter notes`).toBeGreaterThanOrEqual(2);
      expect(materialized.notes.length, `${template.id} should stay small enough to scan`).toBeLessThanOrEqual(6);

      const keys = new Set(materialized.notes.map((note) => note.key));
      expect(materialized.homepageNoteKey, `${template.id} should declare a homepage note`).toBeTruthy();
      expect(keys.has(materialized.homepageNoteKey!), `${template.id} homepage key must resolve`).toBe(true);
      for (const note of materialized.notes) {
        if (note.parentKey) expect(keys.has(note.parentKey), `${template.id} parent ${note.parentKey}`).toBe(true);
      }

      const notes = new Map<string, Note>();
      for (const [index, note] of materialized.notes.entries()) {
        const parent = note.parentKey ? notes.get(note.parentKey) : null;
        notes.set(note.key, fakeNote("New Document", `n${String(index).padStart(5, "0")}`, parent?.id ?? null));
      }

      const ctx: TemplateNoteContentContext = {
        now,
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

      for (const note of materialized.notes) {
        expect(note.content, `${template.id}:${note.key} should not be an empty page`).toBeTruthy();
        const content = note.content;
        const resolvedContent = typeof content === "function" ? content(ctx) : content;
        if (typeof content === "function") {
          expect(() => content(ctx)).not.toThrow();
        }
        expect(resolvedContent, `${template.id}:${note.key} should use the new script globals`).not.toContain("kit.");
        expect(resolvedContent, `${template.id}:${note.key} should use nb.attachments, not top-level attachments`).not.toMatch(
          /(^|[^\w.])attachments\./,
        );
        expect(resolvedContent, `${template.id}:${note.key} should use nb.tags, not top-level tags`).not.toMatch(/(^|[^\w.])tags\./);
        expect(resolvedContent, `${template.id}:${note.key} should use current.kv, not top-level state`).not.toContain("state.");
        expect(resolvedContent, `${template.id}:${note.key} should use nb.localKV, not top-level localState`).not.toContain("localState");
        expect(resolvedContent, `${template.id}:${note.key} should use block selectors, not note.tasks`).not.toContain("note.tasks");
      }
    }
  });

  test("daily template uses the instantiation year dynamically", () => {
    const materialized = materializeTemplate(templates.find((template) => template.id === "daily-notes")!, new Date(2031, 0, 5));
    const titles = materialized.notes.map((note) => (typeof note.content === "string" ? deriveNoteTitle(note.content) : null));
    expect(titles).toContain("2031");
    expect(titles).not.toContain("2026");
  });

  test("de-CH selects complete German metadata and starter content", () => {
    const german = resolveContents("de-CH");
    expect(german.map(({ template }) => template.name)).toEqual(["Tagebuch", "Gartentagebuch", "Rezepte und Vorräte", "Leseliste"]);

    const visibleText = german.flatMap(({ contents }) => contents.map(prose)).join("\n");
    expect(visibleText).not.toMatch(
      /\b(?:Start here|How to use|Daily dashboard|Garden Dashboard|Reading Dashboard|Kitchen Dashboard|Monthly focus|Year notes|Inbox entries|Book notes|Recipe schema|No current reads|No recipe notes|Add queue item|Add garden task)\b/,
    );
    expect(visibleText).toContain("Beginne hier");
    expect(visibleText).toContain("So verwendest du dieses Gartentagebuch");
    expect(visibleText).toContain("Käsespätzle mit Röstzwiebeln");
    expect(visibleText).toContain("Aufmerksamkeit wird als Praxis verstanden");

    const fullText = german.flatMap(({ contents }) => contents).join("\n");
    expect(fullText).not.toMatch(
      /"(?:Daily dashboard|Garden dashboard|Reading dashboard|Kitchen dashboard|Open today's note|Make weekly review|Add garden task|Add queue item|No current reads\.|No recipe notes yet\.|No open dashboard tasks\.|Shopping items added)"/,
    );
    const scriptText = german.flatMap(({ contents }) => contents.map(scripts)).join("\n");
    expect(scriptText).toContain("// Tagebuchübersicht");
    expect(scriptText).toContain('ui.heading("Gartenübersicht für "');
    expect(scriptText).toContain('ui.heading("Leseübersicht"');
    expect(scriptText).toContain('ui.heading("Küchenübersicht"');
  });

  test("German templates preserve note ids and technical Markdown/script selectors", () => {
    const english = resolveContents("en");
    const german = resolveContents("de-CH");

    for (const [index, englishTemplate] of english.entries()) {
      const germanTemplate = german[index]!;
      expect(germanTemplate.template.id).toBe(englishTemplate.template.id);
      expect(germanTemplate.template.homepageNoteKey).toBe(englishTemplate.template.homepageNoteKey);
      expect(germanTemplate.template.notes.map((note) => [note.key, note.parentKey])).toEqual(
        englishTemplate.template.notes.map((note) => [note.key, note.parentKey]),
      );
      expect(germanTemplate.contents.flatMap(references)).toEqual(englishTemplate.contents.flatMap(references));
      expect(germanTemplate.contents.flatMap(scriptSelectors)).toEqual(englishTemplate.contents.flatMap(scriptSelectors));
    }
  });
});
