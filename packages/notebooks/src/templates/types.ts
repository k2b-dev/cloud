import type { Notebook } from "../service/notebooks";
import type { Note } from "../service/notes";

export type TemplateContext = {
  now: Date;
  locale?: string;
};

export type TemplateNoteContentContext = TemplateContext & {
  notebook: Notebook;
  notes: Map<string, Note>;
  link: (key: string, label: string) => string;
  noteId: (key: string) => string;
};

export type TemplateContent = string | ((ctx: TemplateNoteContentContext) => string);

export type TemplateNote = {
  key: string;
  content?: TemplateContent;
  children?: TemplateNote[];
};

export type NotebookTemplate = {
  id: string;
  name: string;
  description: string;
  icon: string;
  notebookName: string | ((ctx: TemplateContext) => string);
  notebookDescription?: string | ((ctx: TemplateContext) => string);
  homepageNoteKey?: string;
  notes: (ctx: TemplateContext) => TemplateNote[];
  translations?: Record<string, Partial<Pick<NotebookTemplate, "name" | "description" | "notebookName" | "notebookDescription">>>;
};

export type MaterializedTemplateNote = {
  key: string;
  content?: TemplateContent;
  parentKey: string | null;
  position: number;
};

const resolveText = (value: string | ((ctx: TemplateContext) => string) | undefined, ctx: TemplateContext): string | undefined =>
  typeof value === "function" ? value(ctx) : value;

const walkNotes = (notes: TemplateNote[], ctx: TemplateContext, parentKey: string | null, out: MaterializedTemplateNote[]) => {
  notes.forEach((note, position) => {
    out.push({
      key: note.key,
      content: note.content,
      parentKey,
      position,
    });
    if (note.children) walkNotes(note.children, ctx, note.key, out);
  });
};

export const materializeTemplate = (template: NotebookTemplate, now = new Date(), locale = "en") => {
  const ctx: TemplateContext = { now, locale };
  const language = locale.split("-")[0]?.toLowerCase() ?? "en";
  const localized = template.translations?.[locale] ?? template.translations?.[language];
  const notes: MaterializedTemplateNote[] = [];
  walkNotes(template.notes(ctx), ctx, null, notes);

  return {
    id: template.id,
    name: localized?.name ?? template.name,
    description: localized?.description ?? template.description,
    icon: template.icon,
    notebookName: resolveText(localized?.notebookName ?? template.notebookName, ctx) ?? localized?.name ?? template.name,
    notebookDescription:
      resolveText(localized?.notebookDescription ?? template.notebookDescription, ctx) ?? localized?.description ?? template.description,
    homepageNoteKey: template.homepageNoteKey,
    notes,
  };
};

export const noteLink = (ctx: TemplateNoteContentContext, key: string, label: string): string => {
  const note = ctx.notes.get(key);
  if (!note) throw new Error(`template note not found: ${key}`);
  return `[${label}](note://${note.shortId})`;
};
