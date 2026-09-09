import { type DateContext, dates } from "@k2b/stdlib";
import { renderLiquidTemplate, validateLiquidTemplate } from "@k2b/cloud/shared";
import { normalizeNoteTitle } from "./note-title";

export const DEFAULT_NOTE_TITLE_TEMPLATE = "New Document";

export type NoteTitleTemplateContext = {
  notebook: {
    id: string;
    name: string;
  };
  note: {
    id: string;
    depth: number;
  };
  parent: {
    exists: boolean;
    id: string;
    title: string;
    path: string;
  };
  date: string;
  time: string;
  datetime: string;
  timezone: string;
};

export const buildNoteTitleTemplateContext = (params: {
  notebook: NoteTitleTemplateContext["notebook"];
  note: NoteTitleTemplateContext["note"];
  parent?: Partial<NoteTitleTemplateContext["parent"]>;
  dateConfig: DateContext;
  now?: Date;
}): NoteTitleTemplateContext => {
  const now = params.now ?? new Date();
  const timezone = params.dateConfig.timeZone ?? "UTC";
  return {
    notebook: params.notebook,
    note: params.note,
    parent: {
      exists: params.parent?.exists ?? false,
      id: params.parent?.id ?? "",
      title: params.parent?.title ?? "",
      path: params.parent?.path ?? "",
    },
    date: dates.formatDateKey(now, params.dateConfig),
    time: dates.formatTime(now, params.dateConfig),
    datetime: dates.instantToZonedInput(now, timezone),
    timezone,
  };
};

export const validateNoteTitleTemplate = (template: string): { ok: true } | { ok: false; error: string } =>
  validateLiquidTemplate(template, { escapeOutput: false });

export const renderNoteTitleTemplate = (template: string, context: NoteTitleTemplateContext): string => {
  const rendered = renderLiquidTemplate(template, context, { escapeOutput: false });
  const firstLine = rendered.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!firstLine) throw new Error("Default note title template rendered an empty title");
  const title = normalizeNoteTitle(firstLine, "");
  if (!title) throw new Error("Default note title template rendered an empty title");
  return title;
};
