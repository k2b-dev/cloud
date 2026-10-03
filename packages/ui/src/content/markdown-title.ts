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

/** Links and images would lose their target or picture in a plain-text title. */
const hasLinkOrImage = (tokens: readonly Token[]): boolean =>
  tokens.some(
    (token) => token.type === "link" || token.type === "image" || ("tokens" in token && !!token.tokens && hasLinkOrImage(token.tokens)),
  );

/**
 * The document title of Markdown that starts with a level-one heading: its plain text, and the Markdown after it.
 * Null when the first block is anything else, the heading has no text or holds a link or image, or nothing follows
 * it; the heading then stays in the document.
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
    const body = source.slice(offset + token.raw.length);
    if (hasLinkOrImage(token.tokens ?? []) || !body.trim()) return null;
    const title = decodeEntities(plainText(token.tokens ?? []))
      .replace(/\s+/g, " ")
      .trim();
    return title ? { title, body } : null;
  }
  return null;
}
