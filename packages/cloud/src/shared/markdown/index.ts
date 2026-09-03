/**
 * Server-side Markdown renderer using marked.js
 *
 * This module provides markdown rendering that produces HTML matching
 * the visual appearance of the CodeMirror editor extensions.
 */

import { Marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { markdownClient } from "./client";
import { codeExtension } from "./extensions/code";
import { guidedHelpExtension } from "./extensions/guided-help";
import { imagesExtension } from "./extensions/images";
import { infoBlocksExtension } from "./extensions/info-blocks";
import { katexExtension } from "./extensions/katex";
import { linksExtension } from "./extensions/links";
import { markExtension } from "./extensions/mark";
import { subSupExtension } from "./extensions/sub-sup";
import { tablesExtension } from "./extensions/tables";
import { taskListExtension } from "./extensions/task-list";

// Create a configured marked instance
type MarkdownProfile = "content" | "help";

const createMarked = (profile: MarkdownProfile = "content") => {
  const marked = new Marked();

  marked.use({
    breaks: true,
    gfm: true,
  });

  // Apply extensions in order
  // Note: katexExtension must come before codeExtension to handle ```math blocks
  marked.use(infoBlocksExtension());
  marked.use(taskListExtension());
  marked.use(tablesExtension());
  marked.use(linksExtension({ internalTarget: profile === "help" ? "_self" : "_blank" }));
  marked.use(imagesExtension());
  marked.use(katexExtension());
  marked.use(codeExtension());
  // Inline-style decorators come last so they run after structural tokenizers.
  marked.use(markExtension());
  marked.use(subSupExtension());
  if (profile === "help") marked.use(guidedHelpExtension());

  return marked;
};

const marked = createMarked();
const helpMarked = createMarked("help");

const sanitizeRenderedHtml = (html: string): string =>
  sanitizeHtml(html, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      "annotation",
      "aside",
      "br",
      "div",
      "figcaption",
      "figure",
      "i",
      "img",
      "input",
      "mark",
      "math",
      "mfrac",
      "mi",
      "mn",
      "mo",
      "mover",
      "mrow",
      "msqrt",
      "msub",
      "msubsup",
      "msup",
      "mtext",
      "semantics",
      "span",
      "sub",
      "sup",
      "table",
      "tbody",
      "td",
      "th",
      "thead",
      "tr",
    ],
    allowedAttributes: {
      "*": ["aria-hidden", "aria-label", "class", "data-help-icon", "data-tone", "id", "title"],
      a: ["href", "name", "rel", "target", "title"],
      annotation: ["encoding"],
      code: ["class"],
      div: ["class", "data-block-name", "style"],
      img: ["alt", "class", "height", "loading", "src", "title", "width", "style"],
      input: ["checked", "class", "disabled", "type"],
      math: ["xmlns"],
      pre: ["class"],
      span: ["aria-hidden", "class", "style", "title"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel", "note", "attach"],
    allowedSchemesByTag: {
      img: ["http", "https", "attach"],
    },
    allowedStyles: {
      div: {
        height: [/^\d+(?:\.\d+)?px$/],
      },
      img: {
        "max-height": [/^none$/, /^\d+(?:\.\d+)?px$/],
        "max-width": [/^\d+(?:\.\d+)?px$/],
      },
      span: {
        "margin-right": [/^-?\d+(?:\.\d+)?em$/],
        top: [/^-?\d+(?:\.\d+)?em$/],
        width: [/^\d+(?:\.\d+)?%$/],
      },
    },
  });

/**
 * Render markdown to HTML for server-side display.
 * The output matches the visual styling of the CodeMirror editor.
 *
 * Supported features:
 * - GFM (GitHub Flavored Markdown)
 * - Notice cards (:::note, :::info, :::success, :::warning, :::danger)
 * - Task lists with checkboxes
 * - Tables with cell formatting
 * - Styled links and images
 * - Code blocks with language badges
 * - Mermaid diagram containers (requires client-side init)
 *
 * @example
 * ```tsx
 * // In page.tsx (server-side):
 * import { renderMarkdown } from "@/shared/markdown";
 * const html = renderMarkdown(markdownContent);
 *
 * // Pass to MarkdownView component:
 * import { MarkdownView } from "@k2b/ui";
 * <MarkdownView trustedHtml={html} />
 * ```
 *
 * @see MarkdownView component for displaying the rendered HTML
 * @see initMarkdownEnhancements for client-side Mermaid support
 */
export function renderMarkdown(content: string): string {
  if (!content || typeof content !== "string") return "";

  const html = marked.parse(content);
  if (typeof html !== "string") return "";

  return sanitizeRenderedHtml(html);
}

/**
 * Render markdown to HTML synchronously.
 */
export function renderMarkdownSync(content: string): string {
  if (!content || typeof content !== "string") return "";

  const html = marked.parse(content);
  if (typeof html !== "string") return "";

  return sanitizeRenderedHtml(html);
}

/**
 * Render trusted documentation Markdown with guided sections and internal
 * navigation. All fenced code remains visible source, as in ordinary Markdown.
 */
export function renderHelpMarkdown(content: string): string {
  if (!content || typeof content !== "string") return "";
  const html = helpMarked.parse(content);
  return typeof html === "string" ? sanitizeRenderedHtml(html) : "";
}

/** Plain text used by lightweight client-side help search indexes. */
export function markdownToPlainText(content: string): string {
  const html = renderHelpMarkdown(content);
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, " ").trim();
}

export { marked };

export const markdown = {
  render: renderMarkdown,
  renderSync: renderMarkdownSync,
  marked,
  client: markdownClient,
} as const;
