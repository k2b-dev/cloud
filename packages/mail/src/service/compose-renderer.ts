import { EMAIL_HTML_ALLOWED_ATTRIBUTES, EMAIL_HTML_ALLOWED_SCHEMES, EMAIL_HTML_TAGS, markdown } from "@valentinkolb/cloud/shared";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { convert } from "html-to-text";
import juice from "juice";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import sanitizeHtml from "sanitize-html";
import { allowedEmailInlineStyles, EMAIL_INLINE_STYLE_PROPERTY_SET } from "./email-inline-style-policy";
import { renderMailLiquidTemplate, validateMailLiquidTemplate } from "./template-rendering";

const MAX_CSS_RULES = 200;
const MAX_CSS_DECLARATIONS = 1_000;
const MAX_CSS_SELECTOR_BYTES = 200;
const MAX_CSS_VALUE_BYTES = 512;
const MAX_CUSTOM_CSS_BYTES = 32 * 1024;
const MAX_EMAIL_HTML_ELEMENTS = 1_000;
const MAX_COMPOSE_TEMPLATE_SEGMENTS = 100;
const MAX_INLINE_WORK_BYTES = 8 * 1024 * 1024;
const MAX_MARKDOWN_BLOCKS = 1_000;
const MAX_MARKDOWN_LINES = 5_000;
const MAX_MARKDOWN_SYNTAX_MARKERS = 12_000;
const MAX_RENDERED_SOURCE_BYTES = 3 * 1024 * 1024;
const MAIL_CONTENT_CLASS = "mail-content";
const COMPOSE_SEGMENT_START = "\u2063";
const COMPOSE_SEGMENT_END = "\u2064";

const ALLOWED_TAGS = new Set<string>(EMAIL_HTML_TAGS);
const INLINED_EMAIL_ATTRIBUTES = Object.fromEntries(
  [...EMAIL_HTML_TAGS].map((tag) => [tag, [...new Set([...(EMAIL_HTML_ALLOWED_ATTRIBUTES[tag] ?? []), "style"])]]),
);
const UNSAFE_CSS_VALUE = /(?:url|expression|var|attr)\s*\(|[{}@]|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/i;

export const DEFAULT_MAIL_CSS = `
.mail-content {
  color: #18181b;
  font-family: Arial, Helvetica, sans-serif;
  font-size: 15px;
  line-height: 1.55;
  max-width: 720px;
}
.mail-content p { margin: 0 0 12px; }
.mail-content h1 { font-size: 24px; line-height: 1.25; margin: 24px 0 12px; }
.mail-content h2 { font-size: 20px; line-height: 1.3; margin: 20px 0 10px; }
.mail-content h3 { font-size: 17px; line-height: 1.35; margin: 18px 0 8px; }
.mail-content a { color: #0f766e; text-decoration: underline; }
.mail-content ul, .mail-content ol { margin: 0 0 12px; padding-left: 24px; }
.mail-content table { border-collapse: collapse; margin: 12px 0; width: 100%; }
.mail-content th, .mail-content td { border: 1px solid #d4d4d8; padding: 6px 8px; text-align: left; }
.mail-content code { background-color: #f4f4f5; border-radius: 3px; font-family: monospace; padding: 1px 3px; }
`.trim();

const validateSelector = (selector: string): string | null => {
  if (sourceBytes(selector) > MAX_CSS_SELECTOR_BYTES) return "Email CSS selectors are too long";
  try {
    selectorParser((root) => {
      root.walk((node) => {
        if (node.type === "class") {
          if (node.value !== MAIL_CONTENT_CLASS) throw new Error(`Only .${MAIL_CONTENT_CLASS} class selectors are allowed`);
          return;
        }
        if (node.type === "tag") {
          if (!ALLOWED_TAGS.has(node.value.toLowerCase())) throw new Error(`Element selector "${node.value}" is not allowed`);
          return;
        }
        if (node.type === "combinator" || node.type === "selector" || node.type === "root") return;
        throw new Error(`Selector feature "${node.type}" is not allowed`);
      });
    }).processSync(selector);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid CSS selector";
  }
};

export const validateComposeCss = (source: string): Result<string> => {
  const css = source.trim();
  if (!css) return ok("");
  if (sourceBytes(css) > MAX_CUSTOM_CSS_BYTES) {
    return fail(err.badInput(`Email CSS may contain at most ${MAX_CUSTOM_CSS_BYTES / 1024} KB`));
  }
  let root: postcss.Root;
  try {
    root = postcss.parse(css, { from: undefined });
  } catch (error) {
    return fail(err.badInput(error instanceof Error ? error.message : "Email CSS is invalid"));
  }

  let ruleCount = 0;
  let declarationCount = 0;
  let validationError: string | null = null;
  root.walk((node) => {
    if (validationError) return;
    if (node.type === "atrule") {
      validationError = "At-rules are not allowed in email CSS";
      return;
    }
    if (node.type === "rule") {
      ruleCount += 1;
      for (const selector of node.selectors) {
        validationError = validateSelector(selector);
        if (validationError) return;
      }
      return;
    }
    if (node.type !== "decl") return;
    declarationCount += 1;
    const property = node.prop.toLowerCase();
    if (!EMAIL_INLINE_STYLE_PROPERTY_SET.has(property)) {
      validationError = `CSS property "${property}" is not allowed`;
      return;
    }
    if (node.important) {
      validationError = "!important is not allowed in email CSS";
      return;
    }
    if (sourceBytes(node.value) > MAX_CSS_VALUE_BYTES) {
      validationError = `CSS value for "${property}" is too long`;
      return;
    }
    if (UNSAFE_CSS_VALUE.test(node.value)) validationError = `CSS value for "${property}" is not allowed`;
  });

  if (validationError) return fail(err.badInput(validationError));
  if (ruleCount > MAX_CSS_RULES) return fail(err.badInput(`Email CSS may contain at most ${MAX_CSS_RULES} rules`));
  if (declarationCount > MAX_CSS_DECLARATIONS) {
    return fail(err.badInput(`Email CSS may contain at most ${MAX_CSS_DECLARATIONS} declarations`));
  }
  return ok(root.toString());
};

export type ComposeRenderContext = {
  actor: {
    display_name: string;
    email: string;
  };
  mailbox: {
    name: string;
    description: string;
  };
  sender: {
    display_name: string;
    email: string;
    reply_to: string;
  };
  message: {
    subject: string;
    to: string[];
    cc: string[];
  };
};

export type RenderedComposeContent = {
  html: string | null;
  text: string;
};

const isMarkdownLinkDestination = (source: string, offset: number, length: number): boolean =>
  /\]\([^)\n]*$/.test(source.slice(0, offset)) && /^[^)\n]*\)/.test(source.slice(offset + length));

const isUnsupportedMarkdownUrlContext = (source: string, offset: number, length: number): boolean => {
  const prefix = source.slice(0, offset);
  const suffix = source.slice(offset + length);
  const linePrefix = prefix.slice(prefix.lastIndexOf("\n") + 1);
  return (/<[^>\n]*$/.test(prefix) && /^[^>\n]*>/.test(suffix)) || /^\s{0,3}\[[^\]]+\]:\s*\S*$/.test(linePrefix);
};

const sourceBytes = (source: string): number => new TextEncoder().encode(source).byteLength;
const COMPOSE_TEMPLATE_VARIABLES = [
  "actor.display_name",
  "actor.email",
  "mailbox.description",
  "mailbox.name",
  "message.cc",
  "message.subject",
  "message.to",
  "sender.display_name",
  "sender.email",
  "sender.reply_to",
] as const;

const validateMarkdownSourceComplexity = (source: string): Result<void> => {
  let lines = 0;
  let syntaxMarkers = 0;
  let blocks = source.trim() ? 1 : 0;
  let previousLineBlank = false;
  for (const line of source.split("\n")) {
    lines += 1;
    if (lines > MAX_MARKDOWN_LINES) {
      return fail(err.badInput(`Markdown email may contain at most ${MAX_MARKDOWN_LINES} lines`));
    }
    const blank = line.trim().length === 0;
    if (!blank && previousLineBlank) blocks += 1;
    if (!blank && /^\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|~~~|\|)/.test(line)) blocks += 1;
    if (blocks > MAX_MARKDOWN_BLOCKS) {
      return fail(err.badInput(`Markdown email may contain at most ${MAX_MARKDOWN_BLOCKS} blocks`));
    }
    previousLineBlank = blank;
    for (const character of line) {
      if ("\\`*_{}[]()<>#+-.!|>~".includes(character)) syntaxMarkers += 1;
      if (syntaxMarkers > MAX_MARKDOWN_SYNTAX_MARKERS) {
        return fail(err.badInput("Markdown email is too complex to render safely"));
      }
    }
  }
  return ok();
};

export const validateComposeTemplateSource = (source: string): Result<void> => {
  if (source.includes(COMPOSE_SEGMENT_START) || source.includes(COMPOSE_SEGMENT_END)) {
    return fail(err.badInput("Email template contains reserved control characters"));
  }
  const valid = validateMailLiquidTemplate(source, {
    allowedVariables: COMPOSE_TEMPLATE_VARIABLES,
    output: "markdown",
  });
  if (!valid.ok) return valid;
  for (const match of source.matchAll(/{{[\s\S]*?}}/g)) {
    const offset = match.index;
    if (
      offset !== undefined &&
      (isMarkdownLinkDestination(source, offset, match[0].length) || isUnsupportedMarkdownUrlContext(source, offset, match[0].length))
    ) {
      return fail(err.badInput("Liquid output in Markdown link destinations is not supported"));
    }
  }
  return ok();
};

export const markComposeTemplateSegment = (source: string): string => `${COMPOSE_SEGMENT_START}${source}${COMPOSE_SEGMENT_END}`;

const markdownToPlainText = (source: string): Result<string> => {
  const complexity = validateMarkdownSourceComplexity(source);
  if (!complexity.ok) return complexity;
  try {
    const html = sanitizeHtml(markdown.renderSync(source), {
      allowedTags: [...EMAIL_HTML_TAGS],
      allowedAttributes: EMAIL_HTML_ALLOWED_ATTRIBUTES,
      allowedSchemes: [...EMAIL_HTML_ALLOWED_SCHEMES],
    });
    return ok(convert(html, { wordwrap: false }).trimEnd());
  } catch {
    return fail(err.badInput("Compose template could not be converted to plain text"));
  }
};

export const renderComposeTemplateSource = (
  source: string,
  context: ComposeRenderContext,
  format: "plain" | "markdown",
): Result<string> => {
  const valid = validateComposeTemplateSource(source);
  if (!valid.ok) return valid;
  const rendered = renderMailLiquidTemplate(source, context, "markdown");
  if (!rendered.ok && "reason" in rendered.error && rendered.error.reason === "render_too_large") {
    return fail(err.badInput("Rendered email content exceeds the safe size limit"));
  }
  if (!rendered.ok || format === "markdown") return rendered;
  return markdownToPlainText(rendered.data);
};

const renderComposeTemplateSegments = (source: string, context: ComposeRenderContext, format: "plain" | "markdown"): Result<string> => {
  let cursor = 0;
  let outputBytes = 0;
  let segmentCount = 0;
  const output: string[] = [];
  const append = (value: string): Result<void> => {
    outputBytes += sourceBytes(value);
    if (outputBytes > MAX_RENDERED_SOURCE_BYTES) {
      return fail(err.badInput("Rendered email content exceeds the safe size limit"));
    }
    output.push(value);
    return ok();
  };
  while (cursor < source.length) {
    const start = source.indexOf(COMPOSE_SEGMENT_START, cursor);
    if (start < 0) {
      const tail = append(source.slice(cursor));
      if (!tail.ok) return tail;
      break;
    }
    const plain = append(source.slice(cursor, start));
    if (!plain.ok) return plain;
    const end = source.indexOf(COMPOSE_SEGMENT_END, start + COMPOSE_SEGMENT_START.length);
    const nestedStart = source.indexOf(COMPOSE_SEGMENT_START, start + COMPOSE_SEGMENT_START.length);
    if (end < 0 || (nestedStart >= 0 && nestedStart < end)) {
      return fail(err.badInput("Email contains an invalid signature segment"));
    }
    segmentCount += 1;
    if (segmentCount > MAX_COMPOSE_TEMPLATE_SEGMENTS) {
      return fail(err.badInput(`Email may contain at most ${MAX_COMPOSE_TEMPLATE_SEGMENTS} signature segments`));
    }
    const rendered = renderComposeTemplateSource(source.slice(start + COMPOSE_SEGMENT_START.length, end), context, format);
    if (!rendered.ok) return rendered;
    const segment = append(rendered.data);
    if (!segment.ok) return segment;
    cursor = end + COMPOSE_SEGMENT_END.length;
  }
  const cleaned = output.join("");
  return cleaned.includes(COMPOSE_SEGMENT_END) ? fail(err.badInput("Email contains an invalid signature segment")) : ok(cleaned);
};

export const renderComposeContent = (params: {
  body: string;
  format: "plain" | "markdown";
  customCss: string;
  context: ComposeRenderContext;
  renderLiquid: boolean;
}): Result<RenderedComposeContent> => {
  const css = validateComposeCss(params.customCss);
  if (!css.ok) return css;

  const renderedSource = params.renderLiquid
    ? renderComposeTemplateSegments(params.body, params.context, params.format)
    : ok(params.body.replaceAll(COMPOSE_SEGMENT_START, "").replaceAll(COMPOSE_SEGMENT_END, ""));
  if (!renderedSource.ok) return renderedSource;
  const source = renderedSource.data;
  if (sourceBytes(source) > MAX_RENDERED_SOURCE_BYTES) {
    return fail(err.badInput("Rendered email content exceeds the safe size limit"));
  }
  if (params.format === "plain") return ok({ html: null, text: source });
  const complexity = validateMarkdownSourceComplexity(source);
  if (!complexity.ok) return complexity;

  try {
    const fragment = sanitizeHtml(markdown.renderSync(source), {
      allowedTags: [...EMAIL_HTML_TAGS],
      allowedAttributes: EMAIL_HTML_ALLOWED_ATTRIBUTES,
      allowedSchemes: [...EMAIL_HTML_ALLOWED_SCHEMES],
    });
    const elementCount = fragment.match(/<[a-z][^>]*>/gi)?.length ?? 0;
    if (elementCount > MAX_EMAIL_HTML_ELEMENTS) {
      return fail(err.badInput(`Markdown email may contain at most ${MAX_EMAIL_HTML_ELEMENTS} rendered elements`));
    }
    const effectiveCss = `${DEFAULT_MAIL_CSS}\n${css.data}`;
    if (sourceBytes(fragment) + Math.max(elementCount, 1) * sourceBytes(effectiveCss) > MAX_INLINE_WORK_BYTES) {
      return fail(err.badInput("Email content and CSS are too complex to inline safely"));
    }
    const inlined = juice.inlineContent(`<div class="${MAIL_CONTENT_CLASS}">${fragment}</div>`, effectiveCss, {
      applyStyleTags: false,
      removeStyleTags: true,
      preserveMediaQueries: false,
      preserveFontFaces: false,
      preserveKeyFrames: false,
    });
    if (sourceBytes(inlined) > MAX_RENDERED_SOURCE_BYTES) {
      return fail(err.badInput("Rendered email content exceeds the safe size limit"));
    }
    const html = sanitizeHtml(inlined, {
      allowedTags: [...EMAIL_HTML_TAGS],
      allowedAttributes: INLINED_EMAIL_ATTRIBUTES,
      allowedSchemes: [...EMAIL_HTML_ALLOWED_SCHEMES],
      allowedStyles: allowedEmailInlineStyles(EMAIL_HTML_TAGS),
    });
    if (sourceBytes(html) > MAX_RENDERED_SOURCE_BYTES) {
      return fail(err.badInput("Rendered email content exceeds the safe size limit"));
    }
    return ok({
      html,
      text: convert(html, {
        wordwrap: false,
        selectors: [{ selector: "a", options: { hideLinkHrefIfSameAsText: true } }],
      }).trimEnd(),
    });
  } catch {
    return fail(err.badInput("Message could not be converted to safe email HTML"));
  }
};
