/**
 * Server-side Markdown renderer using marked.js
 *
 * This module provides markdown rendering that produces HTML matching
 * the visual appearance of the CodeMirror editor extensions.
 */

import { formatShortcut, type KeyboardPlatform, markdownInfoBlocks } from "@k2b/ui";
import { Marked, type MarkedExtension, type Token } from "marked";
import sanitizeHtml from "sanitize-html";
import { type HelpLinkResolver, parseHelpReference } from "../help";
import { markdownCalloutSanitizeOptions } from "./callout-sanitizer";
import { markdownClient } from "./client";
import { codeExtension, plainCodeExtension } from "./extensions/code";
import { guidedHelpExtension, headingMetaPattern, helpHeadingSlug } from "./extensions/guided-help";
import { imagesExtension } from "./extensions/images";
import { katexExtension } from "./extensions/katex";
import { linksExtension } from "./extensions/links";
import { markExtension } from "./extensions/mark";
import { subSupExtension } from "./extensions/sub-sup";
import { tablesExtension } from "./extensions/tables";
import { taskListExtension } from "./extensions/task-list";
import { escapeHtml } from "./shared";

// Create a configured marked instance
type MarkdownProfile = "content" | "help";
type LinkStyle = "widget" | "plain";
type MarkdownOutput = "cloud" | "email";

const createMarked = (
  profile: MarkdownProfile,
  links: LinkStyle,
  infoBlocks: MarkedExtension,
  locale?: string,
  output: MarkdownOutput = "cloud",
) => {
  const marked = new Marked();

  marked.use({
    breaks: true,
    gfm: true,
  });

  // Apply extensions in order
  // Note: katexExtension must come before codeExtension to handle ```math blocks
  marked.use(infoBlocks);
  marked.use(taskListExtension());
  marked.use(tablesExtension(output === "email"));
  // Plain output keeps marked's own link renderer and renders code blocks as a bare `pre`.
  // Cloud links are calm reference pills and quiet web links from `@k2b/ui`.
  if (links === "widget") marked.use(linksExtension({ internalTarget: profile === "help" ? "_self" : "_blank", locale }));
  marked.use(imagesExtension());
  marked.use(katexExtension(output === "email"));
  marked.use(links === "widget" ? codeExtension() : plainCodeExtension());
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
const markedFor = (profile: MarkdownProfile, links: LinkStyle = "widget", locale?: string, output: MarkdownOutput = "cloud"): Marked => {
  const infoBlocks = markdownInfoBlocks({ locale });
  const byStyle = instances.get(infoBlocks) ?? new Map<string, Marked>();
  instances.set(infoBlocks, byStyle);
  const key = `${profile}:${links}:${output}`;
  const instance = byStyle.get(key) ?? createMarked(profile, links, infoBlocks, locale, output);
  byStyle.set(key, instance);
  return instance;
};

const marked = markedFor("content");

export type MarkdownRenderOptions = {
  /** `"email"` keeps strikethrough and structural table alignment, and renders table formulas and math as literal source. Defaults to Cloud's styled output with formula evaluation. */
  output?: MarkdownOutput;
  /** `"plain"` renders each link as an ordinary anchor around its text, for HTML read outside Cloud such as email. It also renders a code block, fenced or indented and including a Mermaid fence, as its source in a `pre` without the language label. The default renders references to Cloud content as calm pills and web links as quiet text links. */
  links?: LinkStyle;
  /** Request locale for the screen-reader names of untitled info blocks. Defaults to English on the server and the page language in the browser. */
  locale?: string;
};

const sanitizeRenderedHtml = (html: string, profile: MarkdownProfile = "content", output: MarkdownOutput = "cloud"): string => {
  const callouts = markdownCalloutSanitizeOptions();
  return sanitizeHtml(html, {
    ...callouts,
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      ...(output === "email" ? ["del"] : []),
      "annotation",
      "aside",
      "br",
      "div",
      ...(profile === "help" ? ["details", "summary", "kbd"] : []),
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
      ...callouts.allowedTags,
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
      "*": ["aria-hidden", "aria-label", "class", "data-tone", "id", "title"],
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
      ...(profile === "help" ? { details: [{ name: "data-surface", multiple: false, values: ["plain"] }] } : {}),
      div: ["class", "data-block-name", "style"],
      img: ["alt", "class", "height", "loading", "src", "title", "width", "style"],
      input: ["checked", "class", "disabled", "type"],
      math: ["xmlns"],
      pre: ["class"],
      ...(output === "email" ? { th: ["align"], td: ["align"] } : {}),
      ...callouts.allowedAttributes,
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
};

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

  const html = markedFor("content", options.links, options.locale, options.output).parse(content);
  if (typeof html !== "string") return "";

  return sanitizeRenderedHtml(html, "content", options.output);
}

/**
 * Render markdown to HTML synchronously.
 */
export function renderMarkdownSync(content: string, options: MarkdownRenderOptions = {}): string {
  if (!content || typeof content !== "string") return "";

  const html = markedFor("content", options.links, options.locale, options.output).parse(content);
  if (typeof html !== "string") return "";

  return sanitizeRenderedHtml(html, "content", options.output);
}

/**
 * Render trusted documentation Markdown with guided sections and internal
 * navigation. All fenced code remains visible source, as in ordinary Markdown.
 */
export type HelpMarkdownRenderOptions = { locale?: string; platform?: KeyboardPlatform; links?: HelpLinkResolver };
export type { HelpLinkResolver } from "../help";

/** Lexer shared by rendering, startup validation and agent source conversion. */
export const lexHelpMarkdown = (content: string, locale?: string) => markedFor("help", "widget", locale).lexer(content);
/**
 * Visit tokens in the order of marked's walkTokens. Marked concatenates every visitor result into a new array per
 * token, which grows quadratically with the number of sibling tokens in one paragraph.
 */
export const walkHelpTokens = (tokens: Token[], visitor: (token: Token) => void) => {
  const childTokens = markedFor("help").defaults.extensions?.childTokens ?? {};
  const walk = (list: readonly Token[]) => {
    for (const token of list) {
      visitor(token);
      if (token.type === "table") {
        for (const cell of token.header) walk(cell.tokens);
        for (const row of token.rows) for (const cell of row) walk(cell.tokens);
      } else if (token.type === "list") walk(token.items);
      else if (childTokens[token.type])
        for (const key of childTokens[token.type]!) walk((Reflect.get(token, key) as Token[] | Token[][]).flat(Infinity) as Token[]);
      else if ("tokens" in token && token.tokens) walk(token.tokens);
    }
  };
  walk(tokens);
};

export function renderHelpMarkdown(content: string, options: HelpMarkdownRenderOptions = {}): string {
  if (!content || typeof content !== "string") return "";
  const instance = markedFor("help", "widget", options.locale);
  const tokens = instance.lexer(content);
  const headingIds = new Map<string, number>();
  walkHelpTokens(tokens, (token) => {
    if (token.type === "heading") {
      const base = helpHeadingSlug(token.text.replace(headingMetaPattern, "").trim());
      const occurrence = headingIds.get(base) ?? 0;
      headingIds.set(base, occurrence + 1);
      Reflect.set(token, "helpId", occurrence === 0 ? base : `${base}-${occurrence + 1}`);
    } else if (token.type === "helpKbd") {
      const shortcut = formatShortcut(String(token.keys), { platform: options.platform ?? "other", locale: options.locale });
      token.html = `<kbd class="k2b-kbd"><span class="k2b-sr-only">${escapeHtml(shortcut.name)}</span><span class="k2b-kbd__keys" aria-hidden="true">${shortcut.keys.map((key) => `<kbd class="k2b-kbd__key">${escapeHtml(key.label)}</kbd>`).join("")}</span></kbd>`;
    } else if (token.type === "link" && token.href.startsWith("help:")) {
      const ref = parseHelpReference(token.href.slice(5));
      const target = ref && options.links?.(ref);
      if (target) token.href = target.url + ref.fragment;
      else token.type = "helpUnresolvedLink";
    }
  });
  return sanitizeRenderedHtml(instance.parser(tokens), "help");
}

/** Derive Help search text from already-rendered HTML. */
export function helpHtmlToPlainText(html: string): string {
  // The text a screen reader reads: key names instead of key caps, no decorative separators, and words of
  // adjacent blocks (a callout's title and body, a summary and its details) kept apart.
  const spaced = html.replace(/<\/(?:p|div|summary|li|h[1-6]|td|th)>/g, "$& ");
  // Hidden parts are spans and icons; the filter only sees tags that the first pass keeps.
  const spoken = sanitizeHtml(spaced, {
    allowedTags: ["span", "i"],
    allowedAttributes: { "*": ["aria-hidden"] },
    exclusiveFilter: (frame) => frame.attribs["aria-hidden"] === "true",
  });
  return sanitizeHtml(spoken, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, " ").trim();
}

/** Plain text used by lightweight client-side help search indexes. */
export function markdownToPlainText(content: string, locale?: string): string {
  return helpHtmlToPlainText(renderHelpMarkdown(content, { locale }));
}

export { marked };

export const markdown = {
  render: renderMarkdown,
  renderSync: renderMarkdownSync,
  marked,
  client: markdownClient,
} as const;
