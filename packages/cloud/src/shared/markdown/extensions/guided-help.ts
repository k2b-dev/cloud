import { Lexer, type MarkedExtension, type Token, Tokenizer, type Tokens } from "marked";

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
          const match = /^(\*\*[\s\S]+?\*\*)\{icon="([a-z0-9-]+)"\}/.exec(source);
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
        start: (source) => source.match(/^:::details\s+\S/m)?.index,
        tokenizer: function details(source) {
          const opener = /^:::details[ \t]+([^\n]+)\n/.exec(source);
          if (!opener?.[1]?.trim()) return undefined;
          let offset = opener[0].length;
          let depth = 0;
          let fence: { character: string; length: number } | undefined;
          for (const line of source.slice(offset).split(/(?<=\n)/)) {
            const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
            if (marker) {
              if (!fence) fence = { character: marker[1]![0]!, length: marker[1]!.length };
              else if (marker[1]![0] === fence.character && marker[1]!.length >= fence.length) fence = undefined;
            } else if (!fence) {
              if (/^:::(?:steps|reference|compare|note|info|success|warning|danger)\b/.test(line)) depth += 1;
              else if (/^:::[ \t]*(?:\n|$)/.test(line)) {
                if (depth === 0) {
                  const body = source.slice(opener[0].length, offset);
                  // Callouts need a top-level document; its tokenizer must not share the outer lexer.
                  const options = this.lexer.options;
                  const tokenizer = Object.assign(new Tokenizer(options), options.tokenizer);
                  const extensions = options.extensions
                    ? { ...options.extensions, block: options.extensions.block?.filter((tokenizer) => tokenizer !== details) }
                    : null;
                  const tokens = new Lexer({ ...options, tokenizer, extensions }).lex(body);
                  return {
                    type: "helpDetails",
                    raw: source.slice(0, offset + line.length),
                    title: opener[1].trim(),
                    titleTokens: this.lexer.inlineTokens(opener[1].trim()),
                    tokens,
                  };
                }
                depth -= 1;
              }
            }
            offset += line.length;
          }
          return undefined;
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
