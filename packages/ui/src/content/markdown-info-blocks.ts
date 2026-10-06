import { Lexer, type MarkedExtension, Tokenizer, type TokenizerAndRendererExtension } from "marked";
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
 * The opening line holds `:::`, a type in any letter case, and an optional
 * plain-text title. The block ends at a line holding only `:::`, indented no
 * deeper than the opener; code, lists, quotes, and HTML inside the body cannot
 * end it. The body is ordinary Markdown. A block that is never closed stays
 * ordinary text.
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
  /** Raw Markdown between the opening and closing lines, with `\n` line breaks. */
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

const OPENER = /^( {0,3}):::(note|info|success|warning|danger)(?:[ \t]+(.*?))?[ \t]*$/i;
const START = /^ {0,3}:::(?:note|info|success|warning|danger)(?=[ \t\n]|$)/i;
const OPENERS = /(?<=^|\n) {0,3}:::(?:note|info|success|warning|danger)(?=[ \t\n]|$)/gi;
const CLOSING = /^( {0,3}):::[ \t]*$/;
const FENCE = /^( *)(`{3,}|~{3,})(.*)$/;

type ContainerKind = "code" | "fences" | "list" | "blockquote" | "html";
type ContainerToken = NonNullable<ReturnType<Tokenizer[ContainerKind]>>;

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

/** Column where a list item's text starts, as CommonMark counts it. */
const itemTextIndent = (raw: string): number => {
  const [, bullet = "", gap = ""] = /^( {0,3}(?:[-+*]|\d{1,9}[.)]))( *)/.exec(raw) ?? [];
  return bullet.length + (gap.length >= 1 && gap.length <= 4 && raw[bullet.length + gap.length] !== "\n" ? gap.length : 1);
};

/**
 * Offset of the block's closing line inside a list or quote, or -1. Lazy
 * paragraph lines may hold it; a list item's own fenced code cannot.
 */
const closingLineIn = (token: ContainerToken, indent: number): number => {
  if (token.type !== "list" && token.type !== "blockquote") return -1;
  const items = token.type === "list" ? token.items : [];
  let item = -1;
  let itemStart = 0;
  let itemEnd = 0;
  let text = 0;
  let fence = "";
  for (let from = 0; from < token.raw.length; ) {
    while (item + 1 < items.length && from >= itemEnd) {
      item++;
      itemStart = itemEnd;
      itemEnd += items[item]!.raw.length;
      text = itemTextIndent(items[item]!.raw);
      fence = "";
    }
    const end = lineEnd(token.raw, from);
    const line = token.raw.slice(from, end);
    // A line indented less than the item's text has left the item and its fence.
    if (fence && line.trim() && line.length - line.trimStart().length < text) fence = "";
    // The first line of an item carries its bullet where the text would be indented.
    const marker = items.length ? FENCE.exec(from === itemStart ? " ".repeat(text) + line.slice(text) : line) : null;
    if (fence) {
      if (marker && marker[2]![0] === fence[0] && marker[2]!.length >= fence.length && !marker[3]!.trim()) fence = "";
    } else if (
      marker &&
      marker[1]!.length >= text &&
      marker[1]!.length <= text + 3 &&
      !(marker[2]![0] === "`" && marker[3]!.includes("`"))
    ) {
      fence = marker[2]!;
    } else if (closes(line, indent)) {
      return from;
    }
    from = end + 1;
  }
  return -1;
};

/** Whether `line` starts a block of its own after a paragraph line instead of continuing the paragraph, as marked decides. */
const interruptsParagraph = (line: string): boolean => Lexer.rules.block.gfm.paragraph.exec(`x\n${line}\n`)?.[0] === "x";

/**
 * Reads info blocks in one `\n`-separated source. The opening line reads like
 * a paragraph line, so the body continues it: only a block that may interrupt
 * a paragraph, such as a fence, a list, a quote, or block HTML, hides its
 * lines from the closing line. A scan's only state is its line and whether a
 * paragraph is open there, so a later scan that reaches a line an earlier one
 * passed ends the same way; `outcomes` remembers that, which keeps reading
 * many openers of one document linear.
 */
const infoBlockReader = (source: string) => {
  const outcomes = new Map<number, number>();
  let tokenizer: Tokenizer | undefined;

  /** Code, lists, quotes, and HTML whose lines belong to the body even when one of them reads `:::`. */
  const container = (offset: number, line: string, paragraph: boolean): ContainerToken | undefined => {
    const kind: ContainerKind | undefined = /^(?: {4}| {0,3}\t)/.test(line)
      ? "code"
      : /^ {0,3}(?:`{3,}|~{3,})/.test(line)
        ? "fences"
        : /^ {0,3}(?:[-+*][ \t]|\d{1,9}[.)][ \t])/.test(line)
          ? "list"
          : /^ {0,3}>/.test(line)
            ? "blockquote"
            : /^ {0,3}</.test(line)
              ? "html"
              : undefined;
    if (!kind || (paragraph && !interruptsParagraph(line))) return undefined;
    if (!tokenizer) {
      // One tokenizer per document: its lexer queues inline work that nothing drains.
      tokenizer = new Tokenizer({ gfm: true });
      new Lexer({ gfm: true, tokenizer });
    }
    return tokenizer[kind](source.slice(offset));
  };

  /** Offset of the closing line for a body that starts at `start`, or -1 when the block never closes. */
  const closingLine = (start: number, indent: number): number => {
    const passed: number[] = [];
    let offset = start;
    let paragraph = true;
    let result = -1;
    while (offset < source.length) {
      const key = offset * 8 + indent * 2 + (paragraph ? 1 : 0);
      const known = outcomes.get(key);
      if (known !== undefined) {
        result = known;
        break;
      }
      passed.push(key);
      const end = lineEnd(source, offset);
      const line = source.slice(offset, end);
      if (closes(line, indent)) {
        result = offset;
        break;
      }
      const token = container(offset, line, paragraph);
      if (token) {
        const closing = closingLineIn(token, indent);
        const length = closing < 0 ? token.raw.length : closing;
        if (length > 0) {
          offset += length;
          paragraph = false;
          continue;
        }
      }
      // A blank line ends a paragraph; any other line continues or starts one.
      paragraph = line.trim() !== "";
      offset = Math.min(end + 1, source.length);
    }
    for (const key of passed) outcomes.set(key, result);
    return result;
  };

  return (offset: number): MarkdownInfoBlock | null => {
    const firstEnd = lineEnd(source, offset);
    const opener = OPENER.exec(source.slice(offset, firstEnd));
    if (!opener) return null;
    const indent = opener[1]!.length;
    const type = opener[2]!.toLowerCase() as MarkdownInfoBlockType;
    const title = opener[3]?.trim() || undefined;
    const bodyStart = Math.min(firstEnd + 1, source.length);
    const closing = closingLine(bodyStart, indent);
    if (closing < 0) return { type, title, body: source.slice(bodyStart), length: source.length - offset, closed: false };
    const body = source.slice(bodyStart, closing).replace(/\n$/, "");
    return { type, title, body, length: Math.min(lineEnd(source, closing) + 1, source.length) - offset, closed: true };
  };
};

/**
 * Reads the info block that starts `source`. Returns `null` when the first
 * line is not an info-block opener. Applications with their own Markdown
 * pipeline use this to recognize exactly the blocks `MarkdownView` renders.
 * Any line endings are accepted; `length` counts `source` as given.
 */
export const scanMarkdownInfoBlock = (source: string): MarkdownInfoBlock | null => {
  const normalized = source.replace(/\r\n?/g, "\n");
  const block = infoBlockReader(normalized)(0);
  if (!block || normalized.length === source.length) return block;
  // Only `\r\n` shortens the source; count each one twice up to the block's end.
  let length = 0;
  for (let index = 0; index < block.length; index++) length += source[length] === "\r" && source[length + 1] === "\n" ? 2 : 1;
  return { ...block, length };
};

const renderBlock = (input: Omit<MarkdownInfoBlockRenderInput, "locale">, messages: UiMessages): string => {
  const name = input.title
    ? `<p class="${NOTICE_CARD_CLASSES.title}">${escapeHtml(input.title)}</p>`
    : `<span class="k2b-sr-only">${escapeHtml(LABELS[input.type](messages))}: </span>`;
  return `<aside class="${NOTICE_CARD_CLASSES.root}" data-tone="${TONES[input.type]}" role="note">${name}<div class="${NOTICE_CARD_CLASSES.body}">${input.bodyHtml}</div></aside>`;
};

/**
 * Renders an info block as the calm `NoticeCard`: the tone tints the surface,
 * the text stays neutral, and there is no icon. A title is the visible heading
 * and names the block; without one, the localized type name is announced to
 * screen readers only.
 */
export const renderMarkdownInfoBlock = (input: MarkdownInfoBlockRenderInput): string => renderBlock(input, resolveUiMessages(input.locale));

/**
 * What one `marked` lexer run knows about its document: the opening lines, the
 * blocks read so far, the length of the last top-level source, and the extent
 * of the last top-level paragraph `start` measured.
 */
type DocumentState = {
  source: string;
  read: (offset: number) => MarkdownInfoBlock | null;
  openers: number[];
  blocks: Map<number, MarkdownInfoBlock | null>;
  top: number;
  paragraph: { start: number; end: number };
};

const documents = new WeakMap<object, DocumentState>();

/** The closed block that starts at `offset`, read once per document. */
const closedBlockAt = (document: DocumentState, offset: number): MarkdownInfoBlock | null => {
  let block = document.blocks.get(offset);
  if (block === undefined) {
    const read = document.read(offset);
    block = read?.closed ? read : null;
    document.blocks.set(offset, block);
  }
  return block;
};

/** Index of the first of the ascending `offsets` at or after `from`. */
const firstAtOrAfter = (offsets: readonly number[], from: number): number => {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (offsets[middle]! < from) low = middle + 1;
    else high = middle;
  }
  return low;
};

/**
 * The first closed block after the top-level `position` inside the paragraph
 * that would start there. Openers further away cannot end that paragraph, and
 * a paragraph that starts inside the last measured one ends where it ends.
 */
const nextBlockStart = (document: DocumentState, position: number, rules: RegExp): number | undefined => {
  if (position < document.paragraph.start || position >= document.paragraph.end) {
    const extent = rules.exec(document.source.slice(position))?.[0].length ?? 0;
    document.paragraph = { start: position, end: position + extent };
  }
  for (let index = firstAtOrAfter(document.openers, position + 1); index < document.openers.length; index++) {
    const offset = document.openers[index]!;
    if (offset >= document.paragraph.end) return undefined;
    if (closedBlockAt(document, offset)) return offset;
  }
  return undefined;
};

/** The paragraph rule of the lexer's own flavour. */
const paragraphRule = (lexer: Lexer): RegExp =>
  Lexer.rules.block[lexer.options.pedantic ? "pedantic" : lexer.options.gfm ? "gfm" : "normal"].paragraph;

const createExtension = (messages: UiMessages): MarkedExtension => {
  const extension: TokenizerAndRendererExtension = {
    name: "markdownInfoBlock",
    level: "block",
    // marked ends a top-level paragraph where `start` points. Only a block
    // that closes renders, so `start` points at the first one inside the
    // paragraph; a split anywhere else would only make marked lex the rest of
    // the document again.
    start(source) {
      const document = documents.get(this.lexer);
      // marked asks right after the tokenizer below ran at the same top-level position.
      if (!document || source.length + 1 !== document.top) return undefined;
      const position = document.source.length - source.length - 1;
      const next = nextBlockStart(document, position, paragraphRule(this.lexer));
      return next === undefined ? undefined : next - position - 1;
    },
    tokenizer(source, tokens) {
      let document = documents.get(this.lexer);
      if (tokens !== this.lexer.tokens) {
        // Nested sources are rewritten text, not the rest of the document.
        if (document) document.top = -1;
        return undefined;
      }
      // The first top-level call sees the whole document; later ones see what is left of it.
      if (!document) {
        document = {
          source,
          read: infoBlockReader(source),
          openers: Array.from(source.matchAll(OPENERS), (opener) => opener.index),
          blocks: new Map(),
          top: source.length,
          paragraph: { start: -1, end: -1 },
        };
        documents.set(this.lexer, document);
      }
      document.top = source.length;
      if (!START.test(source)) return undefined;
      const block = closedBlockAt(document, document.source.length - source.length);
      if (!block) return undefined;
      return {
        type: "markdownInfoBlock",
        raw: source.slice(0, block.length),
        blockType: block.type,
        title: block.title,
        tokens: this.lexer.blockTokens(block.body, []),
      };
    },
    renderer(token) {
      return renderBlock(
        {
          type: token.blockType as MarkdownInfoBlockType,
          title: token.title as string | undefined,
          bodyHtml: this.parser.parse(token.tokens ?? []),
        },
        messages,
      );
    },
  };
  return {
    extensions: [extension],
    tokenizer: {
      // A setext heading's text is a paragraph, so it ends before a block as
      // well; marked does not clip it at `start` itself.
      lheading(source) {
        const document = documents.get(this.lexer);
        if (!document || source.length !== document.top) return false;
        const position = document.source.length - source.length;
        const next = nextBlockStart(document, position, paragraphRule(this.lexer));
        return next === undefined ? false : Tokenizer.prototype.lheading.call(this, source.slice(0, next - position));
      },
    },
  };
};

const extensions = new WeakMap<UiMessages, MarkedExtension>();

/**
 * `marked` extension for info blocks at the top level of a document. Blocks
 * inside lists, quotes, or another block stay ordinary text. The body goes
 * through the host's own Markdown renderer, so its escaping and link rules
 * apply unchanged. Locales that share a UI message catalog get the same
 * extension, so a host may cache one `marked` instance per extension.
 */
export const markdownInfoBlocks = (options: { locale?: string } = {}): MarkedExtension => {
  const messages = resolveUiMessages(options.locale);
  const extension = extensions.get(messages) ?? createExtension(messages);
  extensions.set(messages, extension);
  return extension;
};
