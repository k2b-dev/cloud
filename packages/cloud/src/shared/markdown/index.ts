/**
 * Server-side Markdown renderer using marked.js
 *
 * This module provides markdown rendering that produces HTML matching
 * the visual appearance of the CodeMirror editor extensions.
 */

import { markdownInfoBlocks } from "@k2b/ui";
import { Marked, type MarkedExtension } from "marked";
import sanitizeHtml from "sanitize-html";
import { markdownClient } from "./client";
import { codeExtension } from "./extensions/code";
import { guidedHelpExtension } from "./extensions/guided-help";
import { imagesExtension } from "./extensions/images";
import { katexExtension } from "./extensions/katex";
import { linksExtension } from "./extensions/links";
import { markExtension } from "./extensions/mark";
import { subSupExtension } from "./extensions/sub-sup";
import { tablesExtension } from "./extensions/tables";
import { taskListExtension } from "./extensions/task-list";

// Create a configured marked instance
type MarkdownProfile = "content" | "help";
type LinkStyle = "widget" | "plain";

const createMarked = (profile: MarkdownProfile, links: LinkStyle, infoBlocks: MarkedExtension, locale?: string) => {
  const marked = new Marked();

  marked.use({
    breaks: true,
    gfm: true,
  });

  // Apply extensions in order
  // Note: katexExtension must come before codeExtension to handle ```math blocks
  marked.use(infoBlocks);
  marked.use(taskListExtension());
  marked.use(tablesExtension());
  // Plain links keep marked's own renderer: an anchor around the link text.
  // Cloud links are calm reference pills and quiet web links from `@k2b/ui`.
  if (links === "widget") marked.use(linksExtension({ internalTarget: profile === "help" ? "_self" : "_blank", locale }));
  marked.use(imagesExtension());
  marked.use(katexExtension());
  marked.use(codeExtension());
  // Inline-style decorators come last so they run after structural tokenizers.
  marked.use(markExtension());
  marked.use(subSupExtension());
  if (profile === "help") marked.use(guidedHelpExtension());

  return marked;
};

// One instance per UI message catalog, not per requested locale: request
// headers choose the locale, and `markdownInfoBlocks()` returns one extension
// for every locale that shares a catalog, so the cache stays bounded.
const instances = new Map<MarkedExtension, Map<string, Marked>>();
const markedFor = (profile: MarkdownProfile, links: LinkStyle = "widget", locale?: string): Marked => {
  const infoBlocks = markdownInfoBlocks({ locale });
  const byStyle = instances.get(infoBlocks) ?? new Map<string, Marked>();
  instances.set(infoBlocks, byStyle);
  const key = `${profile}:${links}`;
  const instance = byStyle.get(key) ?? createMarked(profile, links, infoBlocks, locale);
  byStyle.set(key, instance);
  return instance;
};

const marked = markedFor("content");

export type MarkdownRenderOptions = {
  /** `"plain"` renders each link as an ordinary anchor around its text, for HTML read outside Cloud such as email. The default renders references to Cloud content as calm pills and web links as quiet text links. */
  links?: LinkStyle;
  /** Request locale for the screen-reader names of untitled info blocks. Defaults to English on the server and the page language in the browser. */
  locale?: string;
};

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
      a: [
        "href",
        "name",
        "rel",
        "target",
        "title",
        { name: "data-link", multiple: false, values: ["web", "mail"] },
        { name: "data-reference", multiple: false, values: ["pdf", "image", "design", "file", "note", "heading", "task", "page"] },
      ],
      annotation: ["encoding"],
      aside: [{ name: "role", multiple: false, values: ["note"] }],
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
 * - Info blocks (:::note, :::info, :::success, :::warning, :::danger), shared
 *   with `MarkdownView` from `@k2b/ui`
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
export function renderMarkdown(content: string, options: MarkdownRenderOptions = {}): string {
  if (!content || typeof content !== "string") return "";

  const html = markedFor("content", options.links, options.locale).parse(content);
  if (typeof html !== "string") return "";

  return sanitizeRenderedHtml(html);
}

/**
 * Render markdown to HTML synchronously.
 */
export function renderMarkdownSync(content: string, options: MarkdownRenderOptions = {}): string {
  if (!content || typeof content !== "string") return "";

  const html = markedFor("content", options.links, options.locale).parse(content);
  if (typeof html !== "string") return "";

  return sanitizeRenderedHtml(html);
}

/**
 * Render trusted documentation Markdown with guided sections and internal
 * navigation. All fenced code remains visible source, as in ordinary Markdown.
 */
export function renderHelpMarkdown(content: string, locale?: string): string {
  if (!content || typeof content !== "string") return "";
  const html = markedFor("help", "widget", locale).parse(content);
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
