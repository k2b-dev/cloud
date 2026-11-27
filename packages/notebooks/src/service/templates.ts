import { err, fail, ok, type Result } from "@k2b/stdlib";
import * as Y from "yjs";
import { deriveNoteTitle, normalizeNoteTitle } from "../lib/note-title";
import {
  getTemplate,
  materializeTemplate,
  type NotebookTemplate,
  noteLink,
  type TemplateNoteContentContext,
  templates,
} from "../templates";
import helloMd from "./hello.md" with { type: "text" };
import { notebookServiceMessages } from "./messages";
import type { Notebook } from "./notebooks";
import * as notebooks from "./notebooks";
import * as notes from "./notes";
import { invalidated, workspaceTransaction } from "./workspace-events";

export type TemplateSummary = {
  id: string;
  name: string;
  description: string;
  icon: string;
};

export type InstantiateTemplateInput = {
  name?: string;
};

type ResultError = Extract<Result<unknown>, { ok: false }>["error"];

class TemplateError extends Error {
  constructor(public readonly resultError: ResultError) {
    super(resultError.message);
  }
}

const toServiceError = (message: string, status: number): ResultError => {
  if (status === 404) return { code: "NOT_FOUND", message, status: 404 };
  if (status === 403) return err.forbidden(message);
  if (status === 409) return err.conflict(message);
  if (status === 500) return err.internal(message);
  return err.badInput(message);
};

const requireResult = <T>(result: Result<T> | { ok: true; data: T } | { ok: false; error: string; status: number }): T => {
  if (!result.ok) {
    throw new TemplateError(
      typeof result.error === "string" ? toServiceError(result.error, "status" in result ? result.status : 400) : result.error,
    );
  }
  return result.data;
};

const markdownToYjsUpdate = (content: string): Uint8Array => {
  const doc = new Y.Doc();
  doc.getText("codemirror").insert(0, content);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
};

export const list = (locale = "en"): TemplateSummary[] =>
  templates.map((template) => {
    const materialized = materializeTemplate(template, new Date(), locale);
    return { id: template.id, name: materialized.name, description: materialized.description, icon: materialized.icon };
  });

/** One page a template makes: its title, and the title of the page it stands under. */
export type TemplatePage = { title: string; parent: string | null };

/** A template's page as it is made: its key, the page it stands under, its title and its Markdown. */
type MadePage = { key: string; parentKey: string | null; title: string; content: string };

/** The pages a template makes, materialized in the person's language; links read as their words, nothing is written. */
const madePages = (id: string, locale: string): MadePage[] | null => {
  const template = getTemplate(id);
  if (!template) return null;
  const now = new Date();
  const materialized = materializeTemplate(template, now, locale);
  const stamp = now.toISOString();
  const notebook: Notebook = {
    id: template.id,
    shortId: template.id,
    name: materialized.notebookName,
    description: materialized.notebookDescription ?? null,
    icon: materialized.icon,
    homepageNoteId: null,
    homepageNoteShortId: null,
    defaultPresentationMode: "write",
    defaultNoteTitleTemplate: "",
    noteDeletePermission: "write",
    createdBy: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const ctx: TemplateNoteContentContext = {
    now,
    locale,
    notebook,
    notes: new Map(),
    link: (_key, label) => label,
    noteId: (key) => key,
  };
  return materialized.notes.map((item) => {
    const content = item.content === undefined ? "" : typeof item.content === "function" ? item.content(ctx) : item.content;
    return { key: item.key, parentKey: item.parentKey ?? null, title: deriveNoteTitle(content), content };
  });
};

/**
 * The pages a template makes, in their order, with the titles they get (the first heading, as on save) in the person's
 * language: what a person sees before choosing it. Bounded by the template itself.
 */
export const outline = (id: string, locale = "en"): TemplatePage[] | null => {
  const pages = madePages(id, locale);
  if (!pages) return null;
  const titles = new Map(pages.map((page) => [page.key, page.title]));
  return pages.map((page) => ({ title: page.title, parent: page.parentKey ? (titles.get(page.parentKey) ?? null) : null }));
};

/** The one page a blank notebook starts with. */
export const welcomeOutline = (): TemplatePage[] => [{ title: deriveNoteTitle(helloMd), parent: null }];

/** What a start card shows of a template: its first table, or its first page. */
export type TemplatePreview = { table: { columns: string[]; rows: string[][] } } | { page: { title: string; text?: string } };

/** How much of a table a preview shows: three columns of its first three rows, as a card has room for. */
const PREVIEW_COLUMNS = 3;
const PREVIEW_ROWS = 3;

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => normalizeNoteTitle(cell, ""));

/** The first Markdown table of a page that has a row under its head, cut to what a preview shows. */
const firstTable = (content: string) => {
  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim().startsWith("|") || !/^\s*\|?\s*:?-{3,}/.test(lines[index + 1] ?? "")) continue;
    const rows: string[][] = [];
    for (const row of lines.slice(index + 2)) {
      if (!row.trim().startsWith("|") || rows.length === PREVIEW_ROWS) break;
      rows.push(cells(row).slice(0, PREVIEW_COLUMNS));
    }
    if (rows.length > 0) return { columns: cells(line).slice(0, PREVIEW_COLUMNS), rows };
  }
  return null;
};

/** A page's title and its first line of plain text: no heading, tag, list, table, quote or directive. */
const pagePreview = (title: string, content: string) => {
  const text = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !/^(#|@|:::|\||[-*+>]\s|\d+[.)]\s|[a-z_]+:\s)/i.test(line));
  return { page: { title, text: text ? normalizeNoteTitle(text, "") || undefined : undefined } };
};

/**
 * What a template's start card shows, in the person's language: the first table it makes (its head and first rows, as
 * words), or else its first page (its title and first line). Bounded: three columns of three rows, one line.
 */
export const preview = (id: string, locale = "en"): TemplatePreview | null => {
  const pages = madePages(id, locale);
  if (!pages?.length) return null;
  for (const page of pages) {
    const table = firstTable(page.content);
    if (table) return { table };
  }
  const [first] = pages;
  return first ? pagePreview(first.title, first.content) : null;
};

/** What a blank notebook's start card shows: its welcome page. */
export const welcomePreview = (): TemplatePreview => pagePreview(deriveNoteTitle(helloMd), helloMd);

export const get = (id: string, locale = "en"): TemplateSummary | null => {
  const template = getTemplate(id);
  if (!template) return null;
  const materialized = materializeTemplate(template, new Date(), locale);
  return { id: materialized.id, name: materialized.name, description: materialized.description, icon: materialized.icon };
};

const createNotes = async (
  template: NotebookTemplate,
  notebook: Notebook,
  actorId: string,
  now: Date,
  locale: string,
): Promise<Map<string, notes.Note>> => {
  const materialized = materializeTemplate(template, now, locale);
  const created = new Map<string, notes.Note>();

  for (const item of materialized.notes) {
    const parent = item.parentKey ? created.get(item.parentKey) : null;
    if (item.parentKey && !parent) {
      throw new TemplateError(err.badInput(`template parent note not found: ${item.parentKey}`));
    }
    const note = requireResult(
      await notes.create({
        data: {
          notebookId: notebook.id,
          parentId: parent?.id,
        },
        creatorId: actorId,
      }),
    );
    created.set(item.key, note);
  }

  const contentCtx: TemplateNoteContentContext = {
    now,
    locale,
    notebook,
    notes: created,
    link: (key: string, label: string) => noteLink(contentCtx, key, label),
    noteId: (key: string) => {
      const note = created.get(key);
      if (!note) throw new TemplateError(err.badInput(`template note not found: ${key}`));
      return note.shortId;
    },
  };

  for (const item of materialized.notes) {
    if (item.content === undefined) continue;
    const note = created.get(item.key);
    if (!note) throw new TemplateError(err.badInput(`template note not found: ${item.key}`));
    const content = typeof item.content === "function" ? item.content(contentCtx) : item.content;
    requireResult(
      await notes.save({
        noteId: note.id,
        yjsState: markdownToYjsUpdate(content),
        contentMd: content,
        createdBy: actorId,
      }),
    );
    const saved = await notes.get({ id: note.id });
    if (!saved) throw new TemplateError(err.internal(`template note disappeared after save: ${item.key}`));
    created.set(item.key, saved);
  }

  return created;
};

export const instantiate = async (
  templateId: string,
  input: InstantiateTemplateInput,
  actorId: string,
  locale = "en",
): Promise<Result<Notebook>> => {
  const { t } = notebookServiceMessages.resolve([locale]);
  const template = getTemplate(templateId);
  if (!template) return fail({ code: "NOT_FOUND", message: t.templateNotFound, status: 404 });

  const now = new Date();
  const materialized = materializeTemplate(template, now, locale);
  const notebook = requireResult(
    await notebooks.create({
      data: {
        name: input.name?.trim() || materialized.notebookName,
        description: materialized.notebookDescription,
        icon: materialized.icon,
      },
      creatorId: actorId,
      seedWelcome: false,
    }),
  );

  try {
    let finalNotebook = notebook;

    const createdNotes = await createNotes(template, finalNotebook, actorId, now, locale);
    if (materialized.homepageNoteKey) {
      const homepage = createdNotes.get(materialized.homepageNoteKey);
      if (!homepage) throw new TemplateError(err.badInput(`template homepage note not found: ${materialized.homepageNoteKey}`));
      finalNotebook = requireResult(await notebooks.update({ id: notebook.id, data: { homepageNoteId: homepage.id } }));
    }

    await workspaceTransaction((tx) =>
      invalidated({ notebookId: notebook.id, reason: "template", scopes: ["notebook", "tree", "tags", "references"] }, tx),
    );
    return ok(finalNotebook);
  } catch (error) {
    await notebooks.remove({ id: notebook.id });
    if (error instanceof TemplateError) return fail(error.resultError);
    const message = error instanceof Error ? error.message : "unknown error";
    console.error("template instantiation failed", { error: message });
    return fail(err.internal(t.templateFailed));
  }
};
