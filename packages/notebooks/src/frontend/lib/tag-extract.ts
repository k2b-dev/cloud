/** Browser-side tag extraction shared by editor pills and notebook navigation.
 * Matches the server tag-index semantics without server-only dependencies. */

/**
 * Tag regex.
 *  - `(?:^|\s)` — only at line-start or after whitespace; never
 *    mid-word, never inside `##` (markdown heading).
 *  - First char must be a letter — excludes `#1` (number) and
 *    `##` heading-marker repetition.
 *  - Subsequent chars are word chars / hyphen, with optional `/`-
 *    separated nesting (`#parent/child`).
 */
const TAG_REGEX = /(?:^|\s)#([a-zA-Z][\w-]*(?:\/[\w-]+)*)/g;

/** Strip fenced + inline code blocks so we don't pick up `#define`
 *  in C samples or `#tag` literals shown in documentation about
 *  the tag syntax. Same output as the old replace-based implementation,
 *  but without routing untrusted note content through dot-star regexes. */
const stripCodeBlocks = (md: string): string => {
  const fenceChunks: string[] = [];
  let cursor = 0;
  while (cursor < md.length) {
    const open = md.indexOf("```", cursor);
    if (open === -1) {
      fenceChunks.push(md.slice(cursor));
      break;
    }
    const close = md.indexOf("```", open + 3);
    if (close === -1) {
      fenceChunks.push(md.slice(cursor));
      break;
    }
    fenceChunks.push(md.slice(cursor, open));
    cursor = close + 3;
  }

  const withoutFences = fenceChunks.join("");
  const inlineChunks: string[] = [];
  cursor = 0;
  while (cursor < withoutFences.length) {
    const open = withoutFences.indexOf("`", cursor);
    if (open === -1) {
      inlineChunks.push(withoutFences.slice(cursor));
      break;
    }
    inlineChunks.push(withoutFences.slice(cursor, open));

    const nextTick = withoutFences.indexOf("`", open + 1);
    const nextLine = withoutFences.indexOf("\n", open + 1);
    const hasClosingTick = nextTick !== -1 && (nextLine === -1 || nextTick < nextLine);
    if (hasClosingTick && nextTick > open + 1) {
      cursor = nextTick + 1;
    } else {
      inlineChunks.push("`");
      cursor = open + 1;
    }
  }
  return inlineChunks.join("");
};

const WHITESPACE_REGEX = /\s/;
const isWhitespace = (char: string): boolean => WHITESPACE_REGEX.test(char);
const isAsciiLetter = (char: string): boolean => (char >= "A" && char <= "Z") || (char >= "a" && char <= "z");
const isTagPart = (char: string): boolean => isAsciiLetter(char) || (char >= "0" && char <= "9") || char === "_" || char === "-";

const readTag = (text: string, hashIndex: number): { tag: string; end: number } | null => {
  const first = text[hashIndex + 1];
  if (!first || !isAsciiLetter(first)) return null;

  let end = hashIndex + 2;
  while (end < text.length && isTagPart(text[end]!)) end++;

  while (text[end] === "/" && isTagPart(text[end + 1] ?? "")) {
    end += 2;
    while (end < text.length && isTagPart(text[end]!)) end++;
  }

  return { tag: text.slice(hashIndex + 1, end).toLowerCase(), end };
};

/** Extract every unique tag (lowercased) referenced from a markdown
 *  body. Returns an empty array for null / empty input. */
export const extractTags = (md: string | null | undefined): string[] => {
  if (!md) return [];
  const stripped = stripCodeBlocks(md);
  const tags = new Set<string>();
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] !== "#") continue;
    if (i > 0 && !isWhitespace(stripped[i - 1]!)) continue;

    const tag = readTag(stripped, i);
    if (!tag) continue;
    tags.add(tag.tag);
    i = tag.end - 1;
  }
  return [...tags];
};
