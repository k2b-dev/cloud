import { Lexer, type MarkedExtension, type Token, type Tokens } from "marked";

export const headingMetaPattern = /\s+\{icon="([a-z0-9-]+)"\}\s*$/i;
export const helpHeadingSlug = (value: string): string =>
  value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";

const headingTitleTokens = (token: Tokens.Heading): Token[] => {
  const tokens = [...token.tokens];
  const trailing = tokens.at(-1);
  if (trailing?.type === "text")
    tokens[tokens.length - 1] = {
      ...trailing,
      raw: trailing.raw.replace(headingMetaPattern, ""),
      text: trailing.text.replace(headingMetaPattern, ""),
    };
  return tokens;
};

const FENCE = /^([ \t]*(?:>[ \t]*|(?:[-+*]|\d+[.)])[ \t]+)*)(`{3,}|~{3,})(.*)$/;
const DIRECTIVE_OPENER = /^ {0,3}:::(?:steps|reference|compare|details|note|info|success|warning|danger)\b/i;
const DIRECTIVE_CLOSER = /^ {0,3}:::[ \t]*$/;
const CALLOUT_OPENER = /^ {0,3}:::(?:note|info|success|warning|danger)\b/i;
const DETAILS_OPENER = /^ {0,3}:::details\b/i;

const detailsLexers = new WeakSet<Lexer>();

/** The indentation column of a line prefix; a tab advances to the next multiple of four, as in Markdown. */
const columns = (prefix: string): number => {
  let column = 0;
  for (const char of prefix) column = char === "\t" ? column + 4 - (column % 4) : column + 1;
  return column;
};
/** The indentation after a prefix's last quote marker. */
const indentAfterQuotes = (prefix: string): number => columns(prefix.slice(prefix.lastIndexOf(">") + 1));

/**
 * A `:::details Title` block up to its own closing `:::`. One directive inside it (steps, reference, compare, a
 * callout, which stays text there) keeps its own closer; directives do not nest further, and fenced code hides
 * its lines. Details never nest; another details opener or a missing closer leaves the first opener as text.
 */
const detailsBlock = (
  source: string,
  start = 0,
): { block?: { raw: string; title: string; body: string; callout: boolean }; stoppedAt: number } => {
  const openerEnd = source.indexOf("\n", start);
  const opener = /^:::details[ \t]+(\S[^\n]*)\n/.exec(source.slice(start, openerEnd + 1));
  if (!opener) return { stoppedAt: source.length };
  let offset = start + opener[0].length;
  let inner = false;
  let callout = false;
  let listContentColumn: number | undefined;
  let fence: { marker: string; prefix: string; quotes: number; list: boolean } | undefined;
  while (offset < source.length) {
    const newline = source.indexOf("\n", offset);
    const end = newline < 0 ? source.length : newline + 1;
    const line = source.slice(offset, end);
    const text = line.replace(/\r?\n$/, "");
    const marker = FENCE.exec(text);
    const prefix = /^[ \t]*(?:>[ \t]*|(?:[-+*]|\d+[.)])[ \t]+)*/.exec(text)![0];
    const quotes = prefix.split(">").length - 1;
    const list = /[-+*]|\d+[.)]/.test(prefix);
    const indentation = indentAfterQuotes(prefix);
    if (fence && (quotes < fence.quotes || (fence.list && text.trim() && columns(/^[ \t>]*/.exec(text)![0]) < columns(fence.prefix))))
      fence = undefined;
    if (!fence) {
      if (list) listContentColumn = indentation;
      else if (text.trim() && listContentColumn !== undefined && indentation < listContentColumn) listContentColumn = undefined;
    }
    if (fence) {
      if (
        marker &&
        marker[2]![0] === fence.marker[0] &&
        marker[2]!.length >= fence.marker.length &&
        /^[ \t]*$/.test(marker[3]!) &&
        quotes === fence.quotes &&
        indentAfterQuotes(marker[1]!) <= indentAfterQuotes(fence.prefix) + 3
      )
        fence = undefined;
    } else if (marker && indentation - (listContentColumn ?? 0) <= 3 && !(marker[2]![0] === "`" && marker[3]!.includes("`")))
      fence = { marker: marker[2]!, prefix: marker[1]!, quotes, list };
    else if (DETAILS_OPENER.test(text)) return { stoppedAt: offset };
    else if (DIRECTIVE_CLOSER.test(text)) {
      if (!inner)
        return {
          block: {
            raw: source.slice(start, end),
            title: opener[1]!.trim(),
            body: source.slice(start + opener[0].length, offset),
            callout,
          },
          stoppedAt: end,
        };
      inner = false;
    } else if (DIRECTIVE_OPENER.test(text)) {
      inner = true;
      callout ||= CALLOUT_OPENER.test(text);
    }
    offset = end;
  }
  return { stoppedAt: source.length };
};

const menuSegments = (tokens: Token[]): Token[][] => {
  const segments: Token[][] = [[]];
  for (const token of tokens) {
    if (token.type !== "text" || !token.text.includes(" → ")) {
      segments.at(-1)!.push(token);
      continue;
    }
    const parts = token.text.split(" → ");
    for (const [index, text] of parts.entries()) {
      if (index > 0) segments.push([]);
      segments.at(-1)!.push({ type: "text", raw: text, text });
    }
  }
  return segments;
};

/** Help-only syntax; per-reader keys, links and heading ids are assigned after lexing. */
export function guidedHelpExtension(): MarkedExtension {
  return {
    renderer: {
      paragraph(token) {
        if (token.tokens.length !== 1 || token.tokens[0]?.type !== "strong" || token.tokens[0].text.includes(" → ")) return false;
        return `<p class="help-eyebrow">${this.parser.parseInline(token.tokens ?? [])}</p>`;
      },
      heading(token) {
        const id: unknown = Reflect.get(token, "helpId");
        const title = this.parser.parseInline(token.depth === 2 ? headingTitleTokens(token) : token.tokens);
        return `<h${token.depth} id="${typeof id === "string" ? id : "section"}"${token.depth === 2 ? ' class="help-section-title"' : ""}>${title}</h${token.depth}>`;
      },
      strong(token) {
        if (!token.text.includes(" → ")) return false;
        const chips = menuSegments(token.tokens ?? []).map(
          (segment) => `<span class="k2b-label-chip">${this.parser.parseInline(segment)}</span>`,
        );
        return `<span class="help-menu-path">${chips.join('<span class="help-menu-path-separator" aria-hidden="true">›</span><span class="k2b-sr-only">→</span>')}</span>`;
      },
    },
    extensions: [
      {
        name: "helpKbd",
        level: "inline",
        start: (source) => source.indexOf(":kbd["),
        tokenizer(source) {
          const match = /^:kbd\[([^\]\n]*)\]/.exec(source);
          return match ? { type: "helpKbd", raw: match[0], keys: match[1] } : undefined;
        },
        renderer: (token) => String(token.html ?? ""),
      },
      {
        name: "helpLabel",
        level: "inline",
        start: (source) => source.indexOf("**"),
        tokenizer(source) {
          const match = /^(\*\*(?:[^*]|\*(?!\*))+?\*\*)\{icon="([a-z0-9-]+)"\}/.exec(source);
          if (!match) return undefined;
          const [strong] = Lexer.lexInline(match[1]!);
          if (strong?.type !== "strong") return undefined;
          const icon = /^\{icon="([a-z0-9-]+)"\}/.exec(source.slice(strong.raw.length));
          if (!icon) return undefined;
          return {
            ...strong,
            type: "helpLabel",
            raw: strong.raw + icon[0],
            icon: icon[1],
            tokens: this.lexer.inlineTokens(strong.text),
          };
        },
        renderer(token) {
          const icon = `<i class="ti ti-${token.icon}" aria-hidden="true"></i>`;
          const segments = menuSegments(token.tokens ?? []);
          const chips = segments.map(
            (segment, index) => `<span class="k2b-label-chip">${index === 0 ? icon : ""}${this.parser.parseInline(segment)}</span>`,
          );
          return segments.length === 1
            ? chips[0]!
            : `<span class="help-menu-path">${chips.join('<span class="help-menu-path-separator" aria-hidden="true">›</span><span class="k2b-sr-only">→</span>')}</span>`;
        },
        childTokens: ["tokens"],
      },
      {
        name: "helpUnresolvedLink",
        level: "inline",
        renderer(token) {
          return this.parser.parseInline(token.tokens ?? []);
        },
        childTokens: ["tokens"],
      },
      {
        name: "helpDetails",
        level: "block",
        tokenizer(source) {
          if (detailsLexers.has(this.lexer)) return undefined;
          const { block } = detailsBlock(source);
          if (!block) return undefined;
          detailsLexers.add(this.lexer);
          try {
            return {
              type: "helpDetails",
              raw: block.raw,
              title: block.title,
              titleTokens: this.lexer.inlineTokens(block.title),
              callout: block.callout,
              // The body joins this document: its links, steps, and reference blocks work as anywhere else.
              tokens: this.lexer.blockTokens(block.body, []),
            };
          } finally {
            detailsLexers.delete(this.lexer);
          }
        },
        renderer(token) {
          return `<details class="k2b-disclosure help-details" data-surface="plain"><summary><span>${this.parser.parseInline(token.titleTokens ?? [])}</span><i class="ti ti-chevron-down k2b-disclosure__chevron" aria-hidden="true"></i></summary><div class="k2b-disclosure__content">${this.parser.parse(token.tokens ?? [])}</div></details>`;
        },
        childTokens: ["titleTokens", "tokens"],
      },
      {
        name: "guidedHelpBlock",
        level: "block",
        start(source) {
          return source.match(/^:::(?:compare|reference|steps)\b/)?.index;
        },
        tokenizer(source) {
          const match = /^:::(compare|reference|steps)[ \t]*\n([\s\S]*?)\n:::(?:\n|$)/.exec(source);
          return match
            ? { type: "guidedHelpBlock", raw: match[0], kind: match[1], tokens: this.lexer.blockTokens(match[2]?.trim() ?? "") }
            : undefined;
        },
        renderer(token) {
          const body = this.parser.parse(token.tokens ?? []);
          return `<div class="help-${token.kind}">${token.kind === "steps" ? body.replace(/<ol([^>]*) class="[^"]*"/, '<ol$1 class="k2b-steps"') : body}</div>`;
        },
        childTokens: ["tokens"],
      },
    ],
  };
}
