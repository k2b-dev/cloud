import { marked, type Token } from "marked";

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The rendered heading turns entities into characters; the plain-text title does the same. */
const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (!name.startsWith("#")) return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });

/** Visible text of inline tokens: link and emphasis text, code text, image alt text, and escaped raw HTML as written. */
const plainText = (tokens: readonly Token[]): string =>
  tokens
    .map((token) => {
      if ("tokens" in token && token.tokens) return plainText(token.tokens);
      if (token.type === "br") return " ";
      return "text" in token && typeof token.text === "string" ? token.text : "";
    })
    .join("");

/**
 * The document title of Markdown that starts with a level-one heading: its plain text, and the Markdown after it.
 * Null when the first block is anything else or the heading has no text.
 */
export function leadingMarkdownTitle(markdown: string): { title: string; body: string } | null {
  const source = markdown.replace(/\r\n?/g, "\n");
  let offset = 0;
  for (const token of marked.lexer(source)) {
    if (token.type === "space") {
      offset += token.raw.length;
      continue;
    }
    if (token.type !== "heading" || token.depth !== 1 || !source.startsWith(token.raw, offset)) return null;
    const title = decodeEntities(plainText(token.tokens ?? []))
      .replace(/\s+/g, " ")
      .trim();
    return title ? { title, body: source.slice(offset + token.raw.length) } : null;
  }
  return null;
}
