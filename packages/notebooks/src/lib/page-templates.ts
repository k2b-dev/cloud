import { NOTE_TABLE_ACTION_MAX_LENGTH } from "./table-actions";

// ==========================
// Page templates: Markdown a new page starts from. Pure, so the server, the browser and the CLI agree.
// ==========================

/** Own templates per notebook, as for Spaces templates; keeps the "+" menu and the settings list bounded. */
export const PAGE_TEMPLATE_LIMIT = 100;
export const PAGE_TEMPLATE_NAME_MAX_LENGTH = 100;
/** A template becomes a page, so it holds what one page holds in the editor. */
export const PAGE_TEMPLATE_MAX_LENGTH = NOTE_TABLE_ACTION_MAX_LENGTH;
/** Own templates use 6-character short IDs; a built-in ID always contains a dash, so the two never meet. */
export const BUILT_IN_PAGE_TEMPLATE_ID = /^[a-z]+(?:-[a-z]+)+$/;

export const isBuiltInPageTemplateId = (id: string): boolean => BUILT_IN_PAGE_TEMPLATE_ID.test(id);

export type PageTemplateSummary = {
  id: string;
  name: string;
  /** One quiet line of what the template holds; own templates have none. */
  description: string | null;
  icon: string;
  builtIn: boolean;
  /** Own templates only. */
  updatedAt: string | null;
};

export type PageTemplatePlaceholders = {
  /** The day the page is made, as `YYYY-MM-DD` in the person's time zone, like `{{date}}` in a notebook's title template. */
  date: string;
  /** Who makes the page; empty when nobody is known. */
  author: string;
};

/** The placeholders a template may hold; any other `{{…}}` stays as typed. */
export const PAGE_TEMPLATE_PLACEHOLDERS = ["date", "author"] as const;

const PLACEHOLDER = /\{\{\s*(date|author)\s*\}\}/g;

/** How long the filled-in template gets, counted without building it, so a size check costs no memory. */
export const renderedPageTemplateLength = (content: string, values: PageTemplatePlaceholders): number => {
  let length = content.length;
  for (const match of content.matchAll(PLACEHOLDER)) length += values[match[1] as keyof PageTemplatePlaceholders].length - match[0].length;
  return length;
};

/** The template's Markdown with `{{date}}` and `{{author}}` filled in. */
export const renderPageTemplate = (content: string, values: PageTemplatePlaceholders): string =>
  content.replace(PLACEHOLDER, (_, key: keyof PageTemplatePlaceholders) => values[key]);

/** A level-1 ATX heading, also an empty one: at most three spaces before `#`; four make it indented code. */
const TITLE_LINE = /^ {0,3}#(?:[ \t]|$)/;

/** A page that holds at most its title: a template may then replace it whole. */
export const isBlankPage = (markdown: string): boolean => {
  const lines = markdown.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.length === 0 || (lines.length === 1 && TITLE_LINE.test(lines[0]!));
};

/** What a template adds inside a page that already has content: everything below its title. */
export const pageTemplateBody = (markdown: string): string => {
  const lines = markdown.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first === -1 || !TITLE_LINE.test(lines[first]!)) return markdown;
  let start = first + 1;
  while (start < lines.length && lines[start]!.trim().length === 0) start++;
  return lines.slice(start).join("\n");
};

/** A template name as stored: trimmed, 1 to 100 characters. */
export const normalizePageTemplateName = (name: string): string | null => {
  const trimmed = name.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 && trimmed.length <= PAGE_TEMPLATE_NAME_MAX_LENGTH ? trimmed : null;
};
