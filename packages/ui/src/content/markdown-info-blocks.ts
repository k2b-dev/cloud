import { Lexer, type MarkedExtension, type Token, Tokenizer, type TokenizerAndRendererExtension } from "marked";
import { resolveUiMessages, type UiMessages } from "../intl/messages";
import { NOTICE_CARD_CLASSES, type NoticeTone } from "../surfaces/NoticeCard";

/**
 * Markdown info blocks: one grammar and one look for every Markdown surface.
 *
 * ```markdown
 * :::warning Before deleting
 * Deleting an item cannot be undone.
 * :::
 * ```
 *
 * The opening line holds `:::`, a type, and an optional plain-text title. The
 * block ends at a line holding only `:::`, indented no deeper than the opener;
 * code, lists, quotes, and HTML inside the body cannot end it. The body is
 * ordinary Markdown. A block that is never closed stays ordinary text.
 */

const TONES = {
  note: "neutral",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "danger",
} as const satisfies Record<string, NoticeTone>;

export type MarkdownInfoBlockType = keyof typeof TONES;

export type MarkdownInfoBlock = {
  type: MarkdownInfoBlockType;
  /** Plain-text title from the opening line. */
  title?: string;
  /** Raw Markdown between the opening and closing lines. */
  body: string;
  /** Source length through the closing line, or the whole source when the block is not closed. */
  length: number;
  closed: boolean;
};

export type MarkdownInfoBlockRenderInput = {
  type: MarkdownInfoBlockType;
  title?: string;
  /** Already rendered body HTML. The caller owns its sanitization. */
  bodyHtml: string;
  /** Locale for the screen-reader name of an untitled block. */
  locale?: string;
};

const OPENER = /^( {0,3}):::(note|info|success|warning|danger)(?:[ \t]+(.*?))?[ \t]*\r?$/;
const START = /^ {0,3}:::(?:note|info|success|warning|danger)(?:[ \t]|\r?$)/m;
const CLOSING = /^( {0,3}):::[ \t]*\r?$/;

const LABELS: Record<MarkdownInfoBlockType, (t: UiMessages) => string> = {
  note: (t) => t.infoBlockNote,
  info: (t) => t.infoBlockInfo,
  success: (t) => t.infoBlockSuccess,
  warning: (t) => t.infoBlockWarning,
  danger: (t) => t.infoBlockDanger,
};

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const lineEnd = (source: string, from: number): number => {
  const end = source.indexOf("\n", from);
  return end < 0 ? source.length : end;
};

const closes = (line: string, indent: number): boolean => {
  const closing = CLOSING.exec(line);
  return !!closing && closing[1]!.length <= indent;
};

let containerTokenizer: Tokenizer | undefined;
const blockTokenizer = (): Tokenizer => {
  if (containerTokenizer) return containerTokenizer;
  containerTokenizer = new Tokenizer({ gfm: true });
  // Wire the public tokenizer to a lexer without parsing ordinary paragraphs.
  new Lexer({ gfm: true, tokenizer: containerTokenizer }).blockTokens("");
  return containerTokenizer;
};

/** Code, lists, quotes, and HTML whose lines belong to the body even when one of them reads `:::`. */
const container = (source: string, line: string): Token | undefined => {
  const tokenizer = blockTokenizer();
  if (/^(?: {4}| {0,3}\t)/.test(line)) return tokenizer.code(source);
  const fence = /^ {0,3}(`{3,}|~{3,})(.*)\r?$/.exec(line);
  if (fence && !(fence[1]![0] === "`" && fence[2]!.includes("`"))) return tokenizer.fences(source);
  if (/^ {0,3}(?:[-+*][ \t]|\d{1,9}[.)][ \t])/.test(line)) return tokenizer.list(source);
  if (/^ {0,3}>/.test(line)) return tokenizer.blockquote(source);
  if (/^ {0,3}</.test(line)) return tokenizer.html(source);
};

/**
 * Reads the info block that starts `source`. Returns `null` when the first
 * line is not an info-block opener. Applications with their own Markdown
 * pipeline use this to recognize exactly the blocks `MarkdownView` renders.
 */
export const scanMarkdownInfoBlock = (source: string): MarkdownInfoBlock | null => {
  const firstEnd = lineEnd(source, 0);
  const opener = OPENER.exec(source.slice(0, firstEnd));
  if (!opener) return null;
  const indent = opener[1]!.length;
  const type = opener[2] as MarkdownInfoBlockType;
  const title = opener[3]?.trim() || undefined;
  const bodyStart = Math.min(firstEnd + 1, source.length);
  let offset = bodyStart;
  while (offset < source.length) {
    const end = lineEnd(source, offset);
    const line = source.slice(offset, end);
    if (closes(line, indent)) {
      const body = source.slice(bodyStart, offset).replace(/\r?\n$/, "");
      return { type, title, body, length: Math.min(end + 1, source.length), closed: true };
    }
    const token = container(source.slice(offset), line);
    if (token) {
      let length = token.raw.length;
      if (token.type === "list" || token.type === "blockquote") {
        // Lazy paragraphs may include the block's own closing line. Nested
        // list or quote content is indented or prefixed and cannot close it.
        let from = 0;
        for (const nested of token.raw.split("\n")) {
          if (closes(nested, indent)) {
            length = from;
            break;
          }
          from += nested.length + 1;
        }
      }
      if (length > 0) {
        offset += length;
        continue;
      }
    }
    offset = Math.min(end + 1, source.length);
  }
  return { type, title, body: source.slice(bodyStart), length: source.length, closed: false };
};

/**
 * Renders an info block as the calm `NoticeCard`: the tone tints the surface,
 * the text stays neutral, and there is no icon. A title is the visible heading
 * and names the block; without one, the localized type name is announced to
 * screen readers only.
 */
export const renderMarkdownInfoBlock = (input: MarkdownInfoBlockRenderInput): string => {
  const name = input.title
    ? `<p class="${NOTICE_CARD_CLASSES.title}">${escapeHtml(input.title)}</p>`
    : `<span class="k2b-sr-only">${escapeHtml(LABELS[input.type](resolveUiMessages(input.locale)))}: </span>`;
  return `<aside class="${NOTICE_CARD_CLASSES.root}" data-tone="${TONES[input.type]}" role="note">${name}<div class="${NOTICE_CARD_CLASSES.body}">${input.bodyHtml}</div></aside>`;
};

/**
 * `marked` extension for info blocks at the top level of a document. Blocks
 * inside lists, quotes, or another block stay ordinary text. The body goes
 * through the host's own Markdown renderer, so its escaping and link rules
 * apply unchanged.
 */
export const markdownInfoBlocks = (options: { locale?: string } = {}): MarkedExtension => {
  const extension: TokenizerAndRendererExtension = {
    name: "markdownInfoBlock",
    level: "block",
    start: (source) => START.exec(source)?.index,
    tokenizer(source, tokens) {
      if (tokens !== this.lexer.tokens) return undefined;
      const block = scanMarkdownInfoBlock(source);
      if (!block?.closed) return undefined;
      return {
        type: "markdownInfoBlock",
        raw: source.slice(0, block.length),
        blockType: block.type,
        title: block.title,
        tokens: this.lexer.blockTokens(block.body, []),
      };
    },
    renderer(token) {
      return renderMarkdownInfoBlock({
        type: token.blockType as MarkdownInfoBlockType,
        title: token.title as string | undefined,
        bodyHtml: this.parser.parse(token.tokens ?? []),
        locale: options.locale,
      });
    },
  };
  return { extensions: [extension] };
};
