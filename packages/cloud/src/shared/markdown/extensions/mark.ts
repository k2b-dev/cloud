/**
 * Mark / Highlight extension for marked.
 *
 * Pandoc + HFM-style highlighting:
 *
 *     ==marked text==
 *
 * Renders to a `<mark>` element with a yellow textmarker-style background.
 * Inner content is parsed as inline markdown so users can mix bold / italic
 * inside highlights.
 */

import type { MarkedExtension, Tokens } from "marked";

const MARK_CLASSES = "not-dark:bg-yellow-300 dark:bg-yellow-400/40 not-dark:text-zinc-900 dark:text-yellow-50 px-0.5 rounded";

export function markExtension(): MarkedExtension {
  return {
    extensions: [
      {
        name: "mark",
        level: "inline",
        start(src: string) {
          // Hint marked at where to start scanning. Two consecutive `=` is
          // cheap to find and unique enough.
          return src.match(/==(?!=)/)?.index;
        },
        tokenizer(src: string) {
          // The inner content must:
          // - not start or end with whitespace (matches Pandoc behaviour)
          // - not contain `=` itself (avoids overlapping with `===` etc.)
          const match = /^==(?!=)([^\s=][^=]*?[^\s=]|[^\s=])==(?!=)/.exec(src);
          if (!match) return undefined;
          return {
            type: "mark",
            raw: match[0],
            text: match[1] ?? "",
            tokens: this.lexer.inlineTokens(match[1] ?? ""),
          };
        },
        renderer(token: Tokens.Generic) {
          const inner = this.parser.parseInline(token.tokens ?? []);
          return `<mark class="${MARK_CLASSES}">${inner}</mark>`;
        },
      },
    ],
  };
}
