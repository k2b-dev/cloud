import { Lexer, Tokenizer } from "marked";
import { closesNotice, isIndentedCodeLine, openingCodeFence } from "./markdown-fences";

const DIRECTIVE = /^ {0,3}:::(?:query|toc|data|note|info|success|warning|danger)[ \t]*$/;
const lineEnd = (source: string, from: number): number => {
  const end = source.indexOf("\n", from);
  return end < 0 ? source.length : end;
};
const blockTokenizer = () => {
  const tokenizer = new Tokenizer({ gfm: true });
  // Wire the public tokenizer to its lexer without parsing ordinary paragraphs.
  new Lexer({ gfm: true, tokenizer }).blockTokens("");
  return tokenizer;
};

const container = (source: string, line: string, tokenizer: Tokenizer) => {
  if (isIndentedCodeLine(line)) return tokenizer.code(source);
  if (openingCodeFence(line)) return tokenizer.fences(source);
  if (/^ {0,3}(?:[-+*][ \t]|\d{1,9}[.)][ \t])/.test(line)) return tokenizer.list(source);
  if (/^ {0,3}>/.test(line)) return tokenizer.blockquote(source);
  if (/^ {0,3}</.test(line)) return tokenizer.html(source);
};

const directiveLength = (source: string, tokenizer: Tokenizer): number | null => {
  const firstEnd = lineEnd(source, 0);
  const firstLine = source.slice(0, firstEnd);
  if (!DIRECTIVE.test(firstLine)) return null;
  const notice = !/^ {0,3}:::(?:query|toc|data)[ \t]*$/.test(firstLine);
  let offset = Math.min(firstEnd + 1, source.length);
  while (offset < source.length) {
    const end = lineEnd(source, offset);
    const line = source.slice(offset, end);
    if (notice ? closesNotice(line, firstLine) : /^ {0,3}:::[ \t]*$/.test(line)) return Math.min(end + 1, source.length);
    if (notice) {
      const token = container(source.slice(offset), line, tokenizer);
      if (token) {
        let length = token.raw.length;
        if (token.type === "list" || token.type === "blockquote") {
          // Lazy paragraphs may include the notice's outer delimiter. Nested
          // list/quote content is indented or prefixed and cannot close it.
          let from = 0;
          for (const nested of token.raw.split("\n")) {
            if (closesNotice(nested, firstLine)) {
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
    }
    offset = Math.min(end + 1, source.length);
  }
  return source.length;
};

/** Exact outer directive extent, shared by the renderer and source scanners. */
export const notebookDirectiveLength = (source: string): number | null => directiveLength(source, blockTokenizer());

/** Zero-based source lines where document-level notebook blocks cannot start. */
export const literalMarkdownLines = (source: string): ReadonlySet<number> => {
  const normalized = source.replace(/\r\n?/g, "\n");
  const tokenizer = blockTokenizer();
  const literal = new Set<number>();
  let offset = 0;
  let lineNumber = 0;
  while (offset < normalized.length) {
    const end = lineEnd(normalized, offset);
    const line = normalized.slice(offset, end);
    const directive = DIRECTIVE.test(line) ? directiveLength(normalized.slice(offset), tokenizer) : null;
    const token =
      directive === null && /^(?:[ \t]|[-+*\d><`~])/.test(line) ? container(normalized.slice(offset), line, tokenizer) : undefined;
    const length = directive ?? token?.raw.length;
    if (length) {
      const raw = normalized.slice(offset, offset + length);
      const newlines = raw.split("\n").length - 1;
      const count = newlines + (raw.endsWith("\n") ? 0 : 1);
      for (let index = directive === null ? 0 : 1; index < count; index++) literal.add(lineNumber + index);
      lineNumber += newlines;
      offset += length;
    } else {
      lineNumber++;
      offset = Math.min(end + 1, normalized.length);
    }
  }
  return literal;
};
