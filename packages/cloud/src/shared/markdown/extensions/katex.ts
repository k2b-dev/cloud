/**
 * KaTeX extension for marked
 *
 * Renders LaTeX math expressions:
 * - Inline: $..$ or \(..\)
 * - Block: $$...$$ or \[..\] or ```math
 *
 * The server renders KaTeX right away. A browser loads KaTeX only when content has math: until then the formula's
 * source stands at its place, in the same containers, and a reactive render shows the formula once KaTeX arrived.
 * Hydration keeps the server's HTML meanwhile, so a page rendered with math shows it from the first frame.
 */

import type { MarkedExtension, Tokens } from "marked";
import { renderLatex } from "#katex-render";
import { escapeHtml } from "../shared";

/**
 * Token shape produced by the math tokenizers below. The marked extension API
 * types renderer params as `Tokens.Generic` (open `[index: string]: any`), so
 * we narrow at the call boundary by reading `latex` off the typed sub-shape.
 */
type MathToken = Tokens.Generic & { latex: string };

function renderBlockMath(latex: string): string {
  try {
    const html =
      renderLatex(latex, true) ?? `<span class="katex-display md-katex-pending"><span class="katex">${escapeHtml(latex)}</span></span>`;
    return `<div class="md-katex-block my-3 flex items-center justify-center">${html}</div>`;
  } catch {
    return `<div class="md-katex-block my-3 flex items-center justify-center text-red-500 text-sm"><i class="ti ti-alert-circle mr-1"></i> Invalid LaTeX</div>`;
  }
}

function renderInlineMath(latex: string): string {
  try {
    const html = renderLatex(latex, false) ?? `<span class="katex md-katex-pending">${escapeHtml(latex)}</span>`;
    return `<span class="md-katex-inline">${html}</span>`;
  } catch {
    return `<span class="md-katex-inline text-red-500 font-mono text-sm">$${latex}$</span>`;
  }
}

export function katexExtension(literal = false): MarkedExtension {
  return {
    extensions: [
      // ```math code blocks
      {
        name: "mathCodeBlock",
        level: "block",
        start(src: string) {
          const match = src.match(/^```math/m);
          return match ? match.index : undefined;
        },
        tokenizer(src: string) {
          const match = /^```math\n([\s\S]*?)\n```/.exec(src);
          if (match) {
            return {
              type: "mathCodeBlock",
              raw: match[0],
              latex: match[1]!.trim(),
            };
          }
          return undefined;
        },
        renderer(token: Tokens.Generic) {
          if (literal) {
            const source = token.raw.slice("```math\n".length, -"\n```".length);
            return `<pre>${escapeHtml(source)}</pre>\n`;
          }
          const latex = (token as MathToken).latex;
          return renderBlockMath(latex);
        },
      },
      // Block math with $$ ... $$
      {
        name: "blockMath",
        level: "block",
        start(src: string) {
          const match = src.match(/\$\$/);
          return match ? match.index : undefined;
        },
        tokenizer(src: string) {
          const match = /^\$\$([\s\S]+?)\$\$/.exec(src);
          if (match) {
            return {
              type: "blockMath",
              raw: match[0],
              latex: match[1]!.trim(),
            };
          }
          return undefined;
        },
        renderer(token: Tokens.Generic) {
          if (literal) return `<p>${escapeHtml(token.raw)}</p>\n`;
          const latex = (token as MathToken).latex;
          return renderBlockMath(latex);
        },
      },
      // Inline math with $ ... $
      {
        name: "inlineMath",
        level: "inline",
        start(src: string) {
          const match = src.match(/(?<!\$)\$(?!\$)/);
          return match ? match.index : undefined;
        },
        tokenizer(src: string) {
          const match = /^(?<!\$)\$(?!\$)([^$\n]+)\$(?!\$)/.exec(src);
          if (match) {
            return {
              type: "inlineMath",
              raw: match[0],
              latex: match[1]!.trim(),
            };
          }
          return undefined;
        },
        renderer(token: Tokens.Generic) {
          if (literal) return escapeHtml(token.raw);
          const latex = (token as MathToken).latex;
          return renderInlineMath(latex);
        },
      },
    ],
  };
}
