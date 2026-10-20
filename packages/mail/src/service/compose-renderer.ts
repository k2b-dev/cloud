import { EMAIL_HTML_ALLOWED_ATTRIBUTES, EMAIL_HTML_SANITIZE_OPTIONS, EMAIL_HTML_TAGS, markdown } from "@k2b/cloud/shared";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { convert } from "html-to-text";
import juice from "juice";
import { Tokenizer, TypeGuards } from "liquidjs";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import sanitizeHtml from "sanitize-html";
import {
  type ComposeFormattingWarning,
  composeTemplateVariables,
  MAX_COMPOSE_FORMATTING_WARNINGS,
  mailboxLogoDisplayHeight,
} from "../contracts";
import { composeRenderFailure } from "./compose-render-errors";
import { allowedEmailInlineStyles, allowedEmailInlineStyleValue, EMAIL_INLINE_STYLE_PROPERTY_SET } from "./email-inline-style-policy";
import { renderMailLiquidTemplate, validateMailLiquidTemplate } from "./template-rendering";

const MAX_CSS_RULES = 200;
const MAX_CSS_DECLARATIONS = 1_000;
const MAX_CSS_SELECTOR_BYTES = 200;
const MAX_CSS_VALUE_BYTES = 512;
const MAX_CUSTOM_CSS_BYTES = 32 * 1024;
const MAX_EMAIL_HTML_ELEMENTS = 1_000;
const MAX_COMPOSE_TEMPLATE_SEGMENTS = 100;
// Legacy segments and the selected signature share one Liquid time budget.
const MAX_COMPOSE_RENDER_MS = 1_000;
const MAX_INLINE_WORK_BYTES = 8 * 1024 * 1024;
const MAX_MARKDOWN_BLOCKS = 1_000;
const MAX_MARKDOWN_LINES = 5_000;
const MAX_MARKDOWN_SYNTAX_MARKERS = 12_000;
const MAX_RENDERED_SOURCE_BYTES = 3 * 1024 * 1024;
const MAIL_CONTENT_CLASS = "mail-content";
const SIGNATURE_CLASS = "mail-signature";
const BLANK_LINE_CLASS = "mail-blank-line";
// Invisible marks around an inserted signature: the text between a matching pair stays a template until preview and send.
const COMPOSE_SEGMENT_START = "\u2063";
const COMPOSE_SEGMENT_END = "\u2064";
const COMPOSE_SEGMENT_MARKS = /[\u2063\u2064]/g;
// A segment is a start mark followed by an end mark with no other mark between them; every other mark is a leftover.
const COMPOSE_SEGMENT = /\u2063([^\u2063\u2064]*)\u2064/g;
const COMPOSE_SEGMENT_OR_LEFTOVER_MARK = /(\u2063[^\u2063\u2064]*\u2064)|[\u2063\u2064]/g;

// Logo tags are owned by Mail, never evaluated as Liquid variables or filters.
const LIQUID_COMPOSE_VARIABLES = Object.keys(composeTemplateVariables).filter((variable) => variable !== "mailbox.logo");
const replaceLogoTags = (source: string, value: string) => {
  const parts: string[] = [];
  let cursor = 0;
  let hasLogo = false;
  let hasCapture = false;
  // Mail's Liquid renderer uses the default delimiters, operators and whitespace options.
  // Top-level tokens preserve quoted strings and raw blocks as Liquid sees them.
  for (const token of new Tokenizer(source).readTopLevelTokens()) {
    if (TypeGuards.isTagToken(token)) {
      if (
        token.name === "capture" ||
        (token.name === "liquid" && token.tokenizer.readLiquidTagTokens().some((line) => line.name === "capture"))
      ) {
        hasCapture = true;
      }
    }
    if (!TypeGuards.isOutputToken(token) || token.content !== "mailbox.logo") continue;
    hasLogo = true;
    const before = source.slice(cursor, token.begin);
    parts.push(token.trimLeft ? before.trimEnd() : before, value);
    cursor = token.end;
    if (token.trimRight) {
      while (cursor < source.length && /\s/.test(source[cursor] ?? "")) cursor += 1;
    }
  }
  parts.push(source.slice(cursor));
  return { source: parts.join(""), hasLogo, hasCapture };
};

const ALLOWED_TAGS = new Set<string>(EMAIL_HTML_TAGS);
const withoutSegmentMarks = (attribs: sanitizeHtml.Attributes): sanitizeHtml.Attributes =>
  Object.fromEntries(Object.entries(attribs).map(([name, value]) => [name, value.replace(COMPOSE_SEGMENT_MARKS, "")]));
/**
 * The last pass over a message. Markdown turns character references such as `&#8291;` into marks, and they
 * must not reach the message. They are removed from the parsed text and attributes before any check runs, so
 * a mark inside `java&#8291;script:` cannot hide the scheme from the check and nothing changes the HTML after it.
 */
const INLINED_EMAIL_SANITIZE_OPTIONS = {
  ...EMAIL_HTML_SANITIZE_OPTIONS,
  allowedAttributes: Object.fromEntries(
    [...EMAIL_HTML_TAGS].map((tag) => [
      tag,
      [...new Set([...(EMAIL_HTML_ALLOWED_ATTRIBUTES[tag] ?? []), "style", ...(tag === "div" || tag === "p" ? ["class"] : [])])],
    ]),
  ),
  // The signature block keeps its class, as mail clients mark signatures, so a reader can tell it from the text.
  allowedClasses: { div: [SIGNATURE_CLASS], p: [BLANK_LINE_CLASS] },
  allowedStyles: allowedEmailInlineStyles(EMAIL_HTML_TAGS),
  transformTags: {
    a: (tagName, attribs) => EMAIL_HTML_SANITIZE_OPTIONS.transformTags.a(tagName, withoutSegmentMarks(attribs)),
    "*": (tagName, attribs) => ({ tagName, attribs: withoutSegmentMarks(attribs) }),
  },
  textFilter: (text) => text.replace(COMPOSE_SEGMENT_MARKS, ""),
} satisfies sanitizeHtml.IOptions;
// A backslash starts a CSS escape, which can spell any function name, such as `u\72l(`.
// juice decodes character references after this check, so `&` could spell quotes or backslashes.
const UNSAFE_CSS_VALUE = /(?:url|expression|var|attr)\s*\(|[{}@\\&]|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/i;
// juice inlines every double quote as a single quote, so a quoted string must not contain the other kind of quote.
const INLINE_SAFE_CSS_QUOTES = /^(?:[^"']|"[^"']*"|'[^"']*')*$/;

/**
 * The built-in design, inlined before the mailbox CSS. It styles only the message, so its element rules need
 * no `.mail-content` scope, and `:where()` gives the wrapper rule no specificity: with the lowest specificity,
 * every rule of the mailbox CSS for the same element wins, including the signature wrapper.
 */
export const DEFAULT_MAIL_CSS = `
:where(.mail-content) {
  color: #18181b;
  font-family: Arial, Helvetica, sans-serif;
  font-size: 15px;
  line-height: 1.55;
  max-width: 720px;
}
:where(.mail-signature) { margin-top: 16px; }
p { margin: 0 0 12px; }
h1 { font-size: 24px; line-height: 1.25; margin: 24px 0 12px; }
h2 { font-size: 20px; line-height: 1.3; margin: 20px 0 10px; }
h3 { font-size: 17px; line-height: 1.35; margin: 18px 0 8px; }
a { color: #0f766e; text-decoration: underline; }
ul, ol { margin: 0 0 12px; padding-left: 24px; }
table { border-collapse: collapse; margin: 12px 0; width: 100%; }
th, td { border: 1px solid #d4d4d8; padding: 6px 8px; text-align: left; }
code { background-color: #f4f4f5; border-radius: 3px; font-family: monospace; padding: 1px 3px; }
blockquote { border-left: 3px solid #d4d4d8; color: #52525b; margin: 0 0 12px; padding-left: 12px; }
pre { background-color: #f4f4f5; border-radius: 4px; font-family: monospace; margin: 0 0 12px; overflow-wrap: break-word; padding: 8px 12px; white-space: pre-wrap; }
`.trim();

const validateSelector = (selector: string): string | null => {
  if (sourceBytes(selector) > MAX_CSS_SELECTOR_BYTES) return "Email CSS selectors are too long";
  try {
    selectorParser((root) => {
      root.walk((node) => {
        if (node.type === "class") {
          if (node.value !== MAIL_CONTENT_CLASS && node.value !== SIGNATURE_CLASS)
            throw new Error(`Only .${MAIL_CONTENT_CLASS} and .${SIGNATURE_CLASS} class selectors are allowed`);
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

// Names reach terminals through the CLI: keep printable ASCII only.
const name = (value: string) => value.replace(/[^\x21-\x7e]/g, "").slice(0, 64) || "?";

const composeCssNodeError = (node: postcss.ChildNode): string | null => {
  if (node.type === "atrule") return "At-rules are not allowed in email CSS";
  if (node.type === "rule") {
    for (const selector of node.selectors) {
      const error = validateSelector(selector);
      if (error) return error;
    }
    return null;
  }
  if (node.type !== "decl") return null;
  const property = node.prop.toLowerCase();
  if (!EMAIL_INLINE_STYLE_PROPERTY_SET.has(property)) return `CSS property "${property}" is not allowed`;
  if (node.important) return "!important is not allowed in email CSS";
  if (sourceBytes(node.value) > MAX_CSS_VALUE_BYTES) return `CSS value for "${property}" is too long`;
  if (
    UNSAFE_CSS_VALUE.test(node.value) ||
    !INLINE_SAFE_CSS_QUOTES.test(node.value) ||
    !allowedEmailInlineStyleValue(property, node.value)
  ) {
    return `CSS value for "${property}" is not allowed`;
  }
  return null;
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
    if (node.type === "rule") ruleCount += 1;
    if (node.type === "decl") declarationCount += 1;
    validationError = composeCssNodeError(node);
  });

  if (validationError) return fail(err.badInput(validationError));
  if (ruleCount > MAX_CSS_RULES) return fail(err.badInput(`Email CSS may contain at most ${MAX_CSS_RULES} rules`));
  if (declarationCount > MAX_CSS_DECLARATIONS) {
    return fail(err.badInput(`Email CSS may contain at most ${MAX_CSS_DECLARATIONS} declarations`));
  }
  return ok(root.toString());
};

/** Keeps safe parts of a stored design so stricter CSS rules never stop a mailbox from sending. */
export const storedComposeCss = (source: string): { css: string; formattingWarnings: ComposeFormattingWarning[] } => {
  const css = source.trim();
  if (!css) return { css: "", formattingWarnings: [] };
  const ignored = (): { css: string; formattingWarnings: ComposeFormattingWarning[] } => ({
    css: "",
    formattingWarnings: [{ code: "ignored_mailbox_css" }],
  });
  if (sourceBytes(css) > MAX_CUSTOM_CSS_BYTES) return ignored();
  try {
    const root = postcss.parse(css, { from: undefined });
    const warnings = new Map<string, ComposeFormattingWarning>();
    const add = (property: string) => {
      const key = name(property);
      if (warnings.size < MAX_COMPOSE_FORMATTING_WARNINGS && !warnings.has(key)) {
        warnings.set(key, { code: "ignored_mailbox_css", property: key });
      }
    };
    root.walk((node) => {
      if (!composeCssNodeError(node)) return;
      if (node.type === "decl") add(node.prop.toLowerCase());
      else if (node.type === "rule") {
        node.walkDecls((declaration) => {
          add(declaration.prop.toLowerCase());
        });
      } else if (node.type === "atrule") add(`@${node.name}`);
      node.remove();
    });
    const validated = validateComposeCss(root.toString());
    if (!validated.ok) return ignored();
    return { css: validated.data, formattingWarnings: [...warnings.values()] };
  } catch {
    return ignored();
  }
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
  formattingWarnings: ComposeFormattingWarning[];
  html: string | null;
  text: string;
  logoUsed: boolean;
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

const validateMarkdownSourceComplexity = (source: string): Result<void> => {
  let lines = 0;
  let syntaxMarkers = 0;
  let blocks = source.trim() ? 1 : 0;
  let previousLineBlank = false;
  for (const line of source.split("\n")) {
    lines += 1;
    if (lines > MAX_MARKDOWN_LINES) {
      return fail(composeRenderFailure("tooManyLines", MAX_MARKDOWN_LINES));
    }
    const blank = line.trim().length === 0;
    if (!blank && previousLineBlank) blocks += 1;
    if (!blank && /^\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|~~~|\|)/.test(line)) blocks += 1;
    if (blocks > MAX_MARKDOWN_BLOCKS) {
      return fail(composeRenderFailure("tooComplex"));
    }
    previousLineBlank = blank;
    for (const character of line) {
      if ("\\`*_{}[]()<>#+-.!|>~".includes(character)) syntaxMarkers += 1;
      if (syntaxMarkers > MAX_MARKDOWN_SYNTAX_MARKERS) {
        return fail(composeRenderFailure("tooComplex"));
      }
    }
  }
  return ok();
};

export const validateComposeTemplateSource = (source: string): Result<void> => {
  if (source.includes(COMPOSE_SEGMENT_START) || source.includes(COMPOSE_SEGMENT_END)) {
    return fail(err.badInput("Email template contains reserved control characters"));
  }
  let replaced: ReturnType<typeof replaceLogoTags>;
  try {
    replaced = replaceLogoTags(source, "");
  } catch {
    // Report malformed input through the existing Liquid validation error; a source the tokenizer rejects never renders.
    const invalid = validateMailLiquidTemplate(source, { allowedVariables: LIQUID_COMPOSE_VARIABLES, output: "markdown" });
    return invalid.ok ? fail(err.badInput("Email template is invalid")) : invalid;
  }
  // Liquid validation bounds and parses the source before the URL-context scan.
  const valid = validateMailLiquidTemplate(replaced.source, {
    allowedVariables: LIQUID_COMPOSE_VARIABLES,
    output: "markdown",
  });
  // Capture turns output into a filterable value, including inside a Liquid block.
  if (replaced.hasLogo && replaced.hasCapture) {
    return fail(err.badInput("{{ mailbox.logo }} cannot be used together with capture"));
  }
  if (!valid.ok) {
    if (valid.error.message.includes('"mailbox.logo" is not available')) {
      return fail(err.badInput(`${valid.error.message} Use {{ mailbox.logo }} alone, without filters or Liquid tags.`));
    }
    return valid;
  }
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

// The separator line that forwardMessageBody writes, in each composer locale.
const FORWARD_SEPARATOR = /^-{10} (?:Forwarded message|Weitergeleitete Nachricht) -{10}$/u;
// The line that quoteReplyBody writes above a quote: "… Ada wrote:" or "Am … schrieb Ada:".
const REPLY_ATTRIBUTION = /\b(?:wrote|schrieb)\b.*:$/iu;
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/u;

/**
 * Splits a body before the history that Mail writes into forwards and replies: a forwarded message from its
 * separator line on, or a quote that ends the body together with its "… wrote:" line. Every other quote,
 * separator-like line or fenced code is the writer's own text, so the signature then goes to the end.
 */
export const splitQuotedHistory = (body: string): { reply: string; history: string } => {
  const lines = body.split("\n");
  // Lines inside fenced code are null: they belong to the writer's text and never start history.
  const text: Array<string | null> = [];
  let fence: string | null = null;
  for (const line of lines.map((value) => value.trimEnd())) {
    const marker = CODE_FENCE.exec(line)?.[1];
    if (fence) {
      text.push(null);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
    } else {
      text.push(marker ? null : line);
      if (marker) fence = marker;
    }
  }
  let start = text.findIndex((line) => line !== null && FORWARD_SEPARATOR.test(line));
  if (start < 0) {
    let last = text.length - 1;
    while (last >= 0 && text[last] === "") last -= 1;
    let attribution = last;
    while (attribution >= 0 && text[attribution]?.startsWith(">")) attribution -= 1;
    const line = text[attribution];
    if (attribution < last && line && REPLY_ATTRIBUTION.test(line)) start = attribution;
  }
  if (start < 0) return { reply: body.trimEnd(), history: "" };
  return {
    reply: lines.slice(0, start).join("\n").trimEnd(),
    history: lines
      .slice(start)
      .join("\n")
      .replace(/^(?:[ \t]*\r?\n)+/, ""),
  };
};

/**
 * Moves a signature that an older draft keeps as a marked segment out of its body, with the blank line that
 * separated it, when the segment is still exactly one of the given signatures. Other segments stay in the body.
 */
export const moveSignatureSegment = (
  body: string,
  signatures: Array<{ id: string; body: string }>,
): { body: string; signatureTemplateId: string } | null => {
  for (const match of body.matchAll(COMPOSE_SEGMENT)) {
    const signature = signatures.find((entry) => entry.body === match[1]);
    if (!signature) continue;
    let start = match.index;
    let end = start + match[0].length;
    if (body.slice(Math.max(0, start - 2), start) === "\n\n") start -= 2;
    else if (body.slice(end, end + 2) === "\n\n") end += 2;
    return { body: body.slice(0, start) + body.slice(end), signatureTemplateId: signature.id };
  }
  return null;
};

/** Removes every marked copy of the given signature, which Mail adds after the body anyway. */
export const withoutSignatureSegments = (body: string, signatureSource: string): string => {
  const signatures = [{ id: "signature", body: signatureSource }];
  let moved = moveSignatureSegment(body, signatures);
  while (moved) {
    body = moved.body;
    moved = moveSignatureSegment(body, signatures);
  }
  return body;
};

const TEMPLATE_SYNTAX = /\{\{|\{%/;

type ComposeBodyPart = { template: boolean; text: string };

/**
 * Splits a draft body into plain text and marked segments, one part at a time, so a caller that stops at the
 * segment cap never reads the rest of the body.
 *
 * A mark outside a segment is left over from a signature that was partly deleted or pasted: it is dropped and
 * its text stays plain.
 */
function* composeBodyParts(body: string): Generator<ComposeBodyPart> {
  let cursor = 0;
  for (const match of body.matchAll(COMPOSE_SEGMENT)) {
    const plain = body.slice(cursor, match.index).replace(COMPOSE_SEGMENT_MARKS, "");
    if (plain) yield { template: false, text: plain };
    yield { template: true, text: match[1] ?? "" };
    cursor = match.index + match[0].length;
  }
  const plain = body.slice(cursor).replace(COMPOSE_SEGMENT_MARKS, "");
  if (plain) yield { template: false, text: plain };
}

/**
 * Whether a marked segment is filled in as a signature. A segment that is no valid signature template, such
 * as the rest of a partly deleted one, is sent as written, so a hand edit never stops a draft from sending.
 */
const isSignatureTemplate = (source: string): boolean => validateComposeTemplateSource(source).ok;

/** Removes leftover marks of partly deleted signatures, so saved drafts keep only complete signature segments. */
export const removeOrphanComposeSegmentMarks = (body: string): string => body.replace(COMPOSE_SEGMENT_OR_LEFTOVER_MARK, "$1");

/**
 * Reports Liquid syntax that would be sent verbatim: outside a marked segment, or in a segment that is no
 * valid signature template.
 *
 * Bodies that left Cloud as a provider draft and came back from another client lose their segment markers,
 * so their template text can no longer be rendered and must be reviewed instead.
 */
export const hasUnrenderedTemplateSyntax = (body: string): boolean => {
  let segmentCount = 0;
  for (const part of composeBodyParts(body)) {
    // Like the renderer, stop at the segment cap: a body with more segments is not sent at all.
    if (part.template && ++segmentCount > MAX_COMPOSE_TEMPLATE_SEGMENTS) return false;
    if (TEMPLATE_SYNTAX.test(part.text) && !(part.template && isSignatureTemplate(part.text))) return true;
  }
  return false;
};

/** Markdown as the sanitized email fragment, before the design is inlined. */
const emailHtmlFragment = (source: string): string =>
  sanitizeHtml(markdown.renderSync(source, { links: "plain" }), EMAIL_HTML_SANITIZE_OPTIONS);

/** Rewrites only block separators and quotes; every other token keeps its raw source. Null means too many spacers. */
const withBlankLinePlaceholders = (source: string, placeholder: string, quietBefore?: number): { source: string; count: number } | null => {
  let count = 0;
  const rewrite = (tokens: ReturnType<typeof markdown.marked.lexer>[number][], original: string, topLevel = false): string | null => {
    const initialCount = count;
    const chunks: string[] = [];
    let offset = 0;
    for (const [index, token] of tokens.entries()) {
      let raw = token.raw;
      if (topLevel) offset += raw.length;
      const previous = tokens[index - 1];
      const next = tokens[index + 1];
      if (
        token.type === "space" &&
        previous &&
        previous.type !== "space" &&
        previous.type !== "def" &&
        next &&
        next.type !== "space" &&
        next.type !== "def" &&
        (!topLevel || offset !== quietBefore)
      ) {
        const trailingNewlines = previous.raw.match(/\n*$/)?.[0].length ?? 0;
        let extra = trailingNewlines - 2;
        if (count + extra > MAX_EMAIL_HTML_ELEMENTS) return null;
        for (const character of raw) {
          if (character === "\n") extra += 1;
          if (count + extra > MAX_EMAIL_HTML_ELEMENTS) return null;
        }
        if (extra > 0) {
          count += extra;
          raw = `${"\n".repeat(Math.max(0, 2 - trailingNewlines))}${`${placeholder}\n\n`.repeat(extra)}`;
        }
      } else if (token.type === "blockquote" && token.tokens && token.tokens.map((inner) => inner.raw).join("") === token.text) {
        const beforeQuote = count;
        const inner = rewrite(token.tokens, token.text);
        if (inner === null) return null;
        if (count > beforeQuote) {
          raw =
            inner
              .split("\n")
              .map((line) => (line ? `> ${line}` : ">"))
              .join("\n") + (raw.match(/\n*$/)?.[0] ?? "");
        }
      }
      chunks.push(raw);
    }
    // Preserve the original bytes when no separator changed, including CRLF and quote syntax.
    return count === initialCount ? original : chunks.join("");
  };
  const rewritten = rewrite(markdown.marked.lexer(source), source, true);
  return rewritten === null ? null : { source: rewritten, count };
};

/** Only Mail-authored spacers bypass the first sanitizer; user HTML still follows the original fragment policy. */
const mailBodyHtmlFragment = (source: string, token: string, quietBefore?: number): Result<string> => {
  const rewritten = withBlankLinePlaceholders(source, token, quietBefore);
  if (rewritten === null) return fail(composeRenderFailure("tooComplex"));
  const html = emailHtmlFragment(rewritten.source).replaceAll(
    `<p>${token}</p>`,
    `<p class="${BLANK_LINE_CLASS}" style="margin:0">&nbsp;</p>`,
  );
  return ok(html.includes(token) ? emailHtmlFragment(source) : html);
};

const markdownToPlainText = (source: string): Result<string> => {
  const complexity = validateMarkdownSourceComplexity(source);
  if (!complexity.ok) return complexity;
  try {
    return ok(convert(emailHtmlFragment(source), { wordwrap: false }).trimEnd());
  } catch {
    return fail(err.badInput("Compose template could not be converted to plain text"));
  }
};

/** Fills in a template that already passed `validateComposeTemplateSource`. */
const fillComposeTemplate = (
  source: string,
  context: ComposeRenderContext,
  output: "plain" | "markdown" | "editable_markdown",
  renderTimeoutMs?: number,
  logoToken = "",
): Result<string> => {
  const rendered = renderMailLiquidTemplate(
    replaceLogoTags(source, logoToken).source,
    context,
    output === "editable_markdown" ? "editable_markdown" : "markdown",
    {
      renderTimeoutMs,
    },
  );
  if (!rendered.ok && "reason" in rendered.error && rendered.error.reason === "render_too_large") {
    return fail(composeRenderFailure("tooLarge"));
  }
  if (!rendered.ok || output !== "plain") return rendered;
  return markdownToPlainText(rendered.data);
};

/** Resolves a snippet into draft source that the author reads and edits, so values appear as typed. */
export const renderComposeTemplateSource = (
  source: string,
  context: ComposeRenderContext,
  format: "plain" | "markdown",
): Result<string> => {
  const valid = validateComposeTemplateSource(source);
  if (!valid.ok) return valid;
  return fillComposeTemplate(source, context, format === "markdown" ? "editable_markdown" : "plain");
};

const renderComposeTemplateSegments = (
  source: string,
  context: ComposeRenderContext,
  format: "plain" | "markdown",
  budget: { remainingMs: number },
  logoToken: string,
): Result<string> => {
  let outputBytes = 0;
  let segmentCount = 0;
  const output: string[] = [];
  for (const part of composeBodyParts(source)) {
    let value = part.text;
    if (part.template) {
      segmentCount += 1;
      if (segmentCount > MAX_COMPOSE_TEMPLATE_SEGMENTS) {
        return fail(composeRenderFailure("tooManySignatures", MAX_COMPOSE_TEMPLATE_SEGMENTS));
      }
      if (isSignatureTemplate(part.text)) {
        const renderStart = performance.now();
        const rendered = fillComposeTemplate(part.text, context, format, Math.max(0, budget.remainingMs), logoToken);
        budget.remainingMs -= performance.now() - renderStart;
        if (!rendered.ok) return "composeRender" in rendered.error ? rendered : fail(composeRenderFailure("signatureFailed"));
        // A filled-in value may itself contain a mark; it must not reach the message.
        value = rendered.data.replace(COMPOSE_SEGMENT_MARKS, "");
      }
    }
    outputBytes += sourceBytes(value);
    if (outputBytes > MAX_RENDERED_SOURCE_BYTES) return fail(composeRenderFailure("tooLarge"));
    output.push(value);
  }
  return ok(output.join(""));
};

const inlineMailHtml = (fragment: string, elementCount: number, css: string): Result<string> => {
  if (sourceBytes(fragment) + Math.max(elementCount, 1) * sourceBytes(css) > MAX_INLINE_WORK_BYTES) {
    return fail(composeRenderFailure("tooComplex"));
  }
  const inlined = juice.inlineContent(`<div class="${MAIL_CONTENT_CLASS}">${fragment}</div>`, css, {
    applyStyleTags: false,
    removeStyleTags: true,
    preserveMediaQueries: false,
    preserveFontFaces: false,
    preserveKeyFrames: false,
  });
  if (sourceBytes(inlined) > MAX_RENDERED_SOURCE_BYTES) return fail(composeRenderFailure("tooLarge"));
  const html = sanitizeHtml(inlined, INLINED_EMAIL_SANITIZE_OPTIONS);
  if (sourceBytes(html) > MAX_RENDERED_SOURCE_BYTES) return fail(composeRenderFailure("tooLarge"));
  return ok(html);
};

export const renderComposeContent = (params: {
  body: string;
  format: "plain" | "markdown";
  customCss: string;
  context: ComposeRenderContext;
  renderLiquid: boolean;
  signature?: string | null;
  logo?: { src: string; altText: string; displayWidth: number; pixelWidth: number; pixelHeight: number; byteLength: number } | null;
}): Result<RenderedComposeContent> => {
  const logoRandomPart = crypto.randomUUID().replaceAll("-", "").toUpperCase();
  const token = `MAILLOGO${logoRandomPart}`;
  const context = params.context;
  const budget = { remainingMs: MAX_COMPOSE_RENDER_MS };
  const renderedSource = params.renderLiquid
    ? renderComposeTemplateSegments(params.body, context, params.format, budget, token)
    : ok(params.body.replace(COMPOSE_SEGMENT_MARKS, ""));
  if (!renderedSource.ok) return renderedSource;
  let source = renderedSource.data;
  let parts: { reply: string; signature: string; history: string } | null = null;
  if (params.signature !== null && params.signature !== undefined) {
    const valid = validateComposeTemplateSource(params.signature);
    if (!valid.ok) return fail(composeRenderFailure("signatureFailed"));
    const start = performance.now();
    const signature = fillComposeTemplate(params.signature, context, params.format, Math.max(0, budget.remainingMs), token);
    budget.remainingMs -= performance.now() - start;
    if (!signature.ok) return "composeRender" in signature.error ? signature : fail(composeRenderFailure("signatureFailed"));
    parts = { ...splitQuotedHistory(source), signature: signature.data.replace(COMPOSE_SEGMENT_MARKS, "") };
    source = [parts.reply, parts.signature, parts.history].filter(Boolean).join("\n\n");
  }
  if (sourceBytes(source) > MAX_RENDERED_SOURCE_BYTES) return fail(composeRenderFailure("tooLarge"));
  // Only intact tokens may reach replacement; transformed or truncated markers must never be sent.
  if (source.replaceAll(token, "").toUpperCase().includes(logoRandomPart)) {
    return fail(composeRenderFailure("signatureFailed"));
  }
  const requestedLogo = source.includes(token);
  const logoWarnings: ComposeFormattingWarning[] = requestedLogo && !params.logo ? [{ code: "missing_mailbox_logo" }] : [];
  if (params.format === "plain") {
    if (!requestedLogo) return ok({ html: null, text: source, formattingWarnings: logoWarnings, logoUsed: false });
    const altText = params.logo?.altText ?? "";
    // Check the expanded size before allocating it: a loop can repeat the placeholder many times.
    const occurrences = source.split(token).length - 1;
    if (sourceBytes(source) + occurrences * (sourceBytes(altText) - token.length) > MAX_RENDERED_SOURCE_BYTES) {
      return fail(composeRenderFailure("tooLarge"));
    }
    return ok({
      html: null,
      text: source.replaceAll(token, () => altText).trimEnd(),
      formattingWarnings: logoWarnings,
      logoUsed: true,
    });
  }
  const complexity = validateMarkdownSourceComplexity(source);
  if (!complexity.ok) return complexity;

  try {
    const blankLineToken = `MAILBLANKLINE${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
    let historyStart: number | undefined;
    if (!parts) {
      const normalized = source.replace(/\r\n?/g, "\n");
      const { history } = splitQuotedHistory(normalized);
      historyStart = history ? normalized.length - history.length : undefined;
    }
    const reply = parts ? mailBodyHtmlFragment(parts.reply, blankLineToken) : mailBodyHtmlFragment(source, blankLineToken, historyStart);
    if (!reply.ok) return reply;
    let fragment = reply.data;
    if (parts) {
      const signature = mailBodyHtmlFragment(parts.signature, blankLineToken);
      if (!signature.ok) return signature;
      const history = mailBodyHtmlFragment(parts.history, blankLineToken);
      if (!history.ok) return history;
      fragment += `<div class="${SIGNATURE_CLASS}">${signature.data}</div>${history.data}`;
    }
    const elementCount = fragment.match(/<[a-z][^>]*>/gi)?.length ?? 0;
    if (elementCount > MAX_EMAIL_HTML_ELEMENTS) {
      return fail(composeRenderFailure("tooComplex"));
    }
    const stored = storedComposeCss(params.customCss);
    const builtInCss = `${DEFAULT_MAIL_CSS}\n`;
    let inlined = inlineMailHtml(fragment, elementCount, `${builtInCss}${stored.css}`);
    let formattingWarnings = stored.formattingWarnings;
    // A mailbox design never stops a message that renders with the built-in design alone.
    if (!inlined.ok && stored.css) {
      inlined = inlineMailHtml(fragment, elementCount, builtInCss);
      formattingWarnings = [{ code: "ignored_mailbox_css" }];
    }
    if (!inlined.ok) return inlined;
    let html = inlined.data;
    if (requestedLogo) {
      // Strip tokens from parsed attributes before replacing text nodes. User HTML
      // and Markdown images have already been rejected by the final sanitizer.
      const stripToken = (attribs: sanitizeHtml.Attributes) =>
        Object.fromEntries(Object.entries(attribs).map(([key, value]) => [key, value.replaceAll(token, "")]));
      html = sanitizeHtml(html, {
        ...INLINED_EMAIL_SANITIZE_OPTIONS,
        transformTags: {
          "*": (tagName, attribs) => ({ tagName, attribs: stripToken(attribs) }),
          a: (tagName, attribs) => EMAIL_HTML_SANITIZE_OPTIONS.transformTags.a(tagName, stripToken(attribs)),
        },
      });
    }
    const logoUsed = requestedLogo && html.includes(token);
    // Charge every surviving occurrence as a data URL even when sending CID HTML.
    // Check before reading/escaping the image source or allocating expanded HTML.
    let logoCount = 0;
    for (let offset = html.indexOf(token); offset >= 0; offset = html.indexOf(token, offset + token.length)) logoCount += 1;
    const imageMarkup = params.logo
      ? `<img src="" alt="${escapeAttribute(params.logo.altText)}" width="${params.logo.displayWidth}" height="${mailboxLogoDisplayHeight(params.logo)}" style="display:block;border:0;height:auto;max-width:100%">`
      : "";
    if (params.logo && logoCount > 0) {
      // JPEG's prefix is one byte longer than PNG's: use that common upper bound.
      const imageBytes = sourceBytes(imageMarkup) + "data:image/jpeg;base64,".length + 4 * Math.ceil(params.logo.byteLength / 3);
      if (sourceBytes(html) + logoCount * (imageBytes - token.length) > MAX_RENDERED_SOURCE_BYTES) {
        return fail(composeRenderFailure("tooLarge"));
      }
      if ((html.match(/<[a-z][^>]*>/gi)?.length ?? 0) + logoCount > MAX_EMAIL_HTML_ELEMENTS) {
        return fail(composeRenderFailure("tooComplex"));
      }
    }
    const src = params.logo && logoCount > 0 ? escapeAttribute(params.logo.src) : "";
    const image = imageMarkup.replace('src=""', () => `src="${src}"`);
    if (sourceBytes(html) + logoCount * (sourceBytes(image) - token.length) > MAX_RENDERED_SOURCE_BYTES) {
      return fail(composeRenderFailure("tooLarge"));
    }
    const text = convert(html, {
      wordwrap: false,
      selectors: [
        { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
        { selector: `p.${BLANK_LINE_CLASS}`, format: "mailBlankLine" },
      ],
      formatters: { mailBlankLine: (_elem, _walk, builder) => builder.addLineBreak() },
    })
      .trimEnd()
      .replaceAll(token, () => params.logo?.altText ?? "");
    return ok({
      formattingWarnings: [...formattingWarnings, ...logoWarnings].slice(0, MAX_COMPOSE_FORMATTING_WARNINGS),
      html: html.replaceAll(token, () => image),
      text: requestedLogo && !params.logo ? text.trimEnd() : text,
      logoUsed,
    });
  } catch {
    return fail(composeRenderFailure("conversionFailed"));
  }
};

type HtmlElement = { tag: string; attribs: Record<string, string> };

/**
 * Reads the opening tags of an HTML fragment in document order, with their attributes as written. It only
 * parses: the returned HTML is discarded, and the copy keeps attributes that the parse itself would drop.
 */
const openingTags = (html: string): HtmlElement[] => {
  const elements: HtmlElement[] = [];
  sanitizeHtml(html, {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    transformTags: {
      "*": (tagName, attribs) => {
        elements.push({ tag: tagName, attribs: { ...attribs } });
        return { tagName, attribs };
      },
    },
  });
  return elements;
};

/** The address as marked writes it into a link; marked leaves an address it cannot encode as plain text. */
const markedLinkAddress = (href: string): string | null => {
  try {
    return encodeURI(href).replace(/%25/g, "%");
  } catch {
    return null;
  }
};
const escapeAttribute = (value: string): string => value.replace(/[&"<>\r\n]/g, (character) => `&#${character.charCodeAt(0)};`);
const openingTag = ({ tag, attribs }: HtmlElement): string =>
  `<${tag}${Object.entries(attribs)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("")}>`;
const styleProperties = (style: string | undefined): Set<string> =>
  new Set(
    (style ?? "")
      .split(";")
      .map((declaration) => declaration.split(":")[0]?.trim().toLowerCase() ?? "")
      .filter(Boolean),
  );

/**
 * Sends each element through the same sanitizing passes as a message and returns what survives, in the same
 * order, or null when the order no longer matches. One HTML block keeps every element raw for Markdown.
 */
const sanitizedElements = (elements: HtmlElement[]): HtmlElement[] | null => {
  // `</br>` would read as a second line break.
  const block = `<div>\n${elements.map((element) => `${openingTag(element)}${element.tag === "br" ? "" : `</${element.tag}>`}`).join("\n")}\n</div>`;
  const kept = openingTags(sanitizeHtml(emailHtmlFragment(block), INLINED_EMAIL_SANITIZE_OPTIONS)).slice(1);
  return kept.length === elements.length && kept.every((element, index) => element.tag === elements[index]?.tag) ? kept : null;
};

/**
 * Reports what the email renderer removes from HTML written into a Markdown body or template: unsupported
 * elements, attributes such as `class` and `style`, and link addresses it does not allow. Markdown images
 * are reported like `<img>`; other Markdown formatting that email leaves out, such as strikethrough, is not.
 * The body is analyzed as written, so a draft, its preview, and a template with the same source report the
 * same list.
 */
export const composeFormattingWarnings = (body: string, format: "plain" | "markdown"): ComposeFormattingWarning[] => {
  if (format !== "markdown") return [];
  try {
    return formattingWarnings(body);
  } catch {
    // Warnings are a hint: they never stop a save or a preview.
    return [];
  }
};

/** Preview warnings list the design first, then the body, capped at the shared limit. */
export const previewFormattingWarnings = (
  designWarnings: ComposeFormattingWarning[],
  body: string,
  format: "plain" | "markdown",
): ComposeFormattingWarning[] => [...designWarnings, ...composeFormattingWarnings(body, format)].slice(0, MAX_COMPOSE_FORMATTING_WARNINGS);

const formattingWarnings = (body: string): ComposeFormattingWarning[] => {
  const source = body.replace(COMPOSE_SEGMENT_MARKS, "");
  // A body the renderer refuses reports that error on preview and send instead.
  if (sourceBytes(source) > MAX_RENDERED_SOURCE_BYTES || !validateMarkdownSourceComplexity(source).ok) return [];

  const warnings = new Map<string, ComposeFormattingWarning>();
  const add = (warning: Exclude<ComposeFormattingWarning, { code: "ignored_mailbox_css" | "missing_mailbox_logo" }>) => {
    const key = `${warning.code}:${warning.element}:${warning.attribute ?? ""}`;
    if (warnings.size < MAX_COMPOSE_FORMATTING_WARNINGS && !warnings.has(key)) warnings.set(key, warning);
  };

  const authored: HtmlElement[] = [];
  markdown.marked.walkTokens(markdown.marked.lexer(source), (token) => {
    if (authored.length >= MAX_EMAIL_HTML_ELEMENTS) return;
    // A block of HTML may start with a closing tag or a comment and still open elements after it.
    if (token.type === "html") authored.push(...openingTags(token.text));
    else if (token.type === "link") {
      // Like marked, which writes the address into the HTML, where character references such as `&#8291;` are read.
      const href = markedLinkAddress(token.href);
      if (href !== null) authored.push(...openingTags(`<a href="${href}">`));
    } else if (token.type === "image") authored.push({ tag: "img", attribs: {} });
  });

  const probes = new Map<string, HtmlElement>();
  for (const element of authored.slice(0, MAX_EMAIL_HTML_ELEMENTS)) {
    if (!ALLOWED_TAGS.has(element.tag)) add({ code: "unsupported_element", element: name(element.tag) });
    else if (Object.keys(element.attribs).length > 0) probes.set(openingTag(element), element);
  }
  const checked = [...probes.values()];
  const kept = checked.length > 0 ? sanitizedElements(checked) : [];
  checked.forEach((element, index) => {
    const survivor = kept?.[index];
    if (!survivor) return;
    for (const [attribute, value] of Object.entries(element.attribs)) {
      if (attribute === "style") {
        const remaining = styleProperties(survivor.attribs.style);
        if ([...styleProperties(value)].some((property) => !remaining.has(property))) {
          add({ code: "unsupported_attribute", element: name(element.tag), attribute });
        }
      } else if (survivor.attribs[attribute] === undefined) {
        add(
          attribute === "href"
            ? { code: "unsupported_link", element: name(element.tag) }
            : { code: "unsupported_attribute", element: name(element.tag), attribute: name(attribute) },
        );
      }
    }
  });
  return [...warnings.values()];
};
