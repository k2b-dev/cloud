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

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const DIRECTIVE_OPENER = /^ {0,3}:::(?:steps|reference|compare|details|note|info|success|warning|danger)\b/i;
const DIRECTIVE_CLOSER = /^ {0,3}:::[ \t]*$/;
const CALLOUT_OPENER = /^ {0,3}:::(?:note|info|success|warning|danger)\b/i;
const DETAILS_OPENER = /^ {0,3}:::details\b/i;

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
  let fence: string | undefined;
  while (offset < source.length) {
    const newline = source.indexOf("\n", offset);
    const end = newline < 0 ? source.length : newline + 1;
    const line = source.slice(offset, end);
    const text = line.replace(/\r?\n$/, "");
    const marker = FENCE.exec(text);
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && /^[ \t]*$/.test(marker[2]!)) fence = undefined;
    } else if (marker && !(marker[1]![0] === "`" && marker[2]!.includes("`"))) fence = marker[1];
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
        start(source) {
          // Only openers in this paragraph can split it. Looking beyond it rescans the rest at every blank line.
          const rules = Lexer.rules.block[this.lexer.options.pedantic ? "pedantic" : this.lexer.options.gfm ? "gfm" : "normal"];
          const extent = rules.paragraph.exec(source)?.[0].length ?? 0;
          const paragraph = source.slice(0, extent);
          const openers = /^:::details[ \t]+\S/gm;
          for (let opener = openers.exec(paragraph); opener; opener = openers.exec(paragraph)) {
            const result = detailsBlock(source, opener.index);
            if (result.block) return opener.index;
            if (result.stoppedAt === source.length) return undefined;
            openers.lastIndex = result.stoppedAt;
          }
          return undefined;
        },
        tokenizer(source) {
          const { block } = detailsBlock(source);
          if (!block) return undefined;
          return {
            type: "helpDetails",
            raw: block.raw,
            title: block.title,
            titleTokens: this.lexer.inlineTokens(block.title),
            callout: block.callout,
            // The body joins this document: its links, steps, and reference blocks work as anywhere else.
            tokens: this.lexer.blockTokens(block.body, []),
          };
        },
        renderer(token) {
          return `<details class="k2b-disclosure help-details" data-surface="plain"><summary><span>${this.parser.parseInline(token.titleTokens ?? [])}</span><i class="ti ti-chevron-down k2b-disclosure__chevron" aria-hidden="true"></i></summary><div class="k2b-disclosure__content">${this.parser.parse(token.tokens ?? [])}</div></details>`;
        },
        childTokens: ["titleTokens", "tokens"],
      },
      {
        name: "guidedHelpBlock",
        level: "block",
        start: (source) => source.match(/^:::(?:compare|reference|steps)\b/m)?.index,
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
