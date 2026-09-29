import {
  buildPresetPdfHtml,
  MarkdownPdfError,
  type MarkdownPdfTemplateId,
  type RenderHtmlToPdfResult,
  renderHtmlToPdf,
} from "@k2b/cloud/services/pdf";
import katexCss from "katex/dist/katex.min.css" with { type: "text" };
import { renderNotebookBook } from "../lib/book-renderer";
import { LIGATURE_CLASS, LIGATURES } from "../lib/ligatures";
import { resolveBookQueries } from "./book";
import type { NoteQueryResult } from "./note-query";

/**
 * Display ligatures that become arrows or relations (`->` →, `!=` ≠), the
 * Unicode blocks Arrows and Mathematical Operators. The presets' fonts in
 * Gotenberg lack these glyphs: Chromium mixes fallback fonts of different
 * sizes and composes `≠` as `=` plus a slash that runs into the next letter.
 * DejaVu Sans, which Gotenberg ships, draws them all alike. The other
 * ligature symbols (`©`, `…`, `–`) exist in every text font and keep the
 * preset's typeface. `:where()` keeps the rule at zero specificity, so any
 * custom CSS rule that styles these spans still wins.
 */
const SYMBOL_LIGATURE_CSS = `:where(${LIGATURES.filter(({ symbol }) => /[←-⋿]/u.test(symbol))
  .map(({ source }) => `.${LIGATURE_CLASS}[title="${source}"]`)
  .join(", ")}) { font-family: "DejaVu Sans", sans-serif; }`;

/**
 * Print styles for the Book renderer's note blocks. They use `em` and plain
 * colours so they sit on top of every preset without Cloud's theme tokens.
 */
const NOTE_PRINT_CSS = `
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.k2b-notice-card { margin: 0 0 1em; padding: .65em .9em; border-left: 4px solid var(--notice-accent); border-radius: 4px; background: var(--notice-tint); break-inside: avoid; }
.k2b-notice-card[data-tone="neutral"] { --notice-accent: #64748b; --notice-tint: #f1f5f9; }
.k2b-notice-card[data-tone="info"] { --notice-accent: #2563eb; --notice-tint: #eff6ff; }
.k2b-notice-card[data-tone="success"] { --notice-accent: #16a34a; --notice-tint: #f0fdf4; }
.k2b-notice-card[data-tone="warning"] { --notice-accent: #d97706; --notice-tint: #fffbeb; }
.k2b-notice-card[data-tone="danger"] { --notice-accent: #dc2626; --notice-tint: #fef2f2; }
.k2b-notice-card__body > :first-child { margin-top: 0; }
.k2b-notice-card__body > :last-child { margin-bottom: 0; }
.md-block-handle { display: inline-block; margin: .5em 0 .25em; padding: .05em .4em; border-radius: 3px; background: #eff6ff; color: #1d4ed8; font: 600 .75em/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
.md-data-block { margin: 0 0 1em; break-inside: avoid; }
.md-data-grid { display: grid; grid-template-columns: minmax(7em, max-content) minmax(0, 1fr); margin: 0; border: 1px solid #cbd5e1; border-radius: 4px; }
.md-data-row { display: contents; }
.md-data-key, .md-data-value { margin: 0; padding: .35em .6em; }
.md-data-row:not(:last-child) > * { border-bottom: 1px solid #e2e8f0; }
.md-data-key { background: #f8fafc; font-weight: 600; }
.md-data-chip { display: inline-block; padding: 0 .35em; border-radius: 3px; background: #eff6ff; color: #1d4ed8; }
.notebook-book-toc ol { padding-left: 0; list-style: none; }
.notebook-book-toc li[data-depth="2"] { padding-left: 1.2em; }
.notebook-book-toc li[data-depth="3"] { padding-left: 2.4em; }
.notebook-book-toc li[data-depth="4"], .notebook-book-toc li[data-depth="5"], .notebook-book-toc li[data-depth="6"] { padding-left: 3.6em; }
a.notebook-book-tag, a.notebook-book-note-link { text-decoration: none; }
a.notebook-book-tag { color: #047857; }
a.notebook-book-note-link { color: #1d4ed8; }
i.ti { display: none; }
.notebook-book-diagnostic { padding: .5em .8em; border-left: 3px solid #cbd5e1; color: #475569; }
.notebook-book-empty, .notebook-book-image-label, .notebook-book-mermaid figcaption { color: #64748b; }
.notebook-book-image-label { font-style: italic; }
.notebook-book-mermaid { margin: 0 0 1em; }
.notebook-book-mermaid figcaption { margin-bottom: .3em; font-size: .85em; }
.md-align-right { display: block; text-align: right; }
.md-align-center { display: block; text-align: center; }
.md-table-total-row td { font-weight: 600; }
.md-table-progress-track { display: inline-block; width: 4em; height: .45em; margin-right: .4em; overflow: hidden; border-radius: 999px; background: #e2e8f0; vertical-align: middle; }
.md-table-progress-fill { display: block; height: 100%; background: #2563eb; }
.md-formula-error { color: #b91c1c; }
.hl-comment { color: #64748b; font-style: italic; }
.hl-keyword { color: #7c3aed; font-weight: 600; }
.hl-string { color: #047857; }
.hl-number { color: #b45309; }
.hl-variable { color: #0369a1; }
.hl-operator { color: #52525b; }
${SYMBOL_LIGATURE_CSS}
`;

// The print preset loads no fonts, so KaTeX's layout rules apply with the fallback serif.
const KATEX_PRINT_CSS = katexCss.replace(/@font-face\s*\{[^}]*\}/g, "");

export type NotePdfHtmlInput = {
  markdown: string;
  notebookShortId: string;
  locale: string;
  templateId?: MarkdownPdfTemplateId;
  customCss?: string;
  queryResults?: ReadonlyMap<number, NoteQueryResult>;
};

/** The reader's Book rendering of a note inside the chosen print preset. */
export const buildNotePdfHtml = (input: NotePdfHtmlInput): string => {
  if (!input.markdown.trim()) throw new MarkdownPdfError("bad_input", "Markdown must not be empty.", "markdown_empty");
  const { html } = renderNotebookBook({
    markdown: input.markdown,
    notebookId: input.notebookShortId,
    locale: input.locale,
    queryResults: input.queryResults,
    print: true,
  });
  const css = html.includes("notebook-book-math") ? `${NOTE_PRINT_CSS}\n${KATEX_PRINT_CSS}` : NOTE_PRINT_CSS;
  return buildPresetPdfHtml({ html, templateId: input.templateId, customCss: input.customCss, css });
};

/** Render the caller's note snapshot as PDF, with query blocks resolved for the caller's access subject. */
export const renderNotePdf = async (
  params: Omit<NotePdfHtmlInput, "queryResults"> & {
    notebookId: string;
    noteId: string;
    userId: string | null;
    serviceAccountId: string | null;
    boundNotebookId: string | null;
    bypassAccess?: boolean;
    title: string;
  },
): Promise<RenderHtmlToPdfResult> => {
  const queryResults = await resolveBookQueries(params);
  return renderHtmlToPdf({ html: buildNotePdfHtml({ ...params, queryResults }), title: params.title });
};
