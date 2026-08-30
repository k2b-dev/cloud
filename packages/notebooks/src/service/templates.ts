import { err, fail, ok, type Result } from "@k2b/stdlib";
import * as Y from "yjs";
import {
  getTemplate,
  materializeTemplate,
  type NotebookTemplate,
  noteLink,
  type TemplateNoteContentContext,
  templates,
} from "../templates";
import { notebookServiceMessages } from "./messages";
import type { Notebook } from "./notebooks";
import * as notebooks from "./notebooks";
import * as notes from "./notes";
import { invalidated } from "./workspace-events";

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
          position: item.position,
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
    let finalNotebook = materialized.scriptsEnabled
      ? requireResult(await notebooks.update({ id: notebook.id, data: { scriptsEnabled: true } }))
      : notebook;

    const createdNotes = await createNotes(template, finalNotebook, actorId, now, locale);
    if (materialized.homepageNoteKey) {
      const homepage = createdNotes.get(materialized.homepageNoteKey);
      if (!homepage) throw new TemplateError(err.badInput(`template homepage note not found: ${materialized.homepageNoteKey}`));
      finalNotebook = requireResult(await notebooks.update({ id: notebook.id, data: { homepageNoteId: homepage.id } }));
    }

    await invalidated({ notebookId: finalNotebook.id, reason: "template", scopes: ["notebook", "tree", "tags", "references"] });
    return ok(finalNotebook);
  } catch (error) {
    await notebooks.remove({ id: notebook.id });
    if (error instanceof TemplateError) return fail(error.resultError);
    const message = error instanceof Error ? error.message : "unknown error";
    console.error("template instantiation failed", { error: message });
    return fail(err.internal(t.templateFailed));
  }
};
