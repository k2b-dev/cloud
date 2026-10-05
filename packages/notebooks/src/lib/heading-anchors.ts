import { text } from "@k2b/stdlib";
import { literalMarkdownLines } from "./markdown-context";

/** Book's id for a heading with this plain text. Book adds `-2`, `-3`, … to a repeated id in document order. */
export const headingAnchor = (title: string): string => `heading-${text.slugify(title) || "section"}`;

/**
 * The note and heading a `note://<shortId>#<anchor>` link names. The anchor is the heading's slug, the way a
 * Markdown viewer reads `backup.md#restore`, so it opens Book's `heading-restore`. An anchor without a slug
 * names no heading; the link opens the note at its top.
 */
export const parseNoteLink = (href: string): { noteId: string; anchor: string | null } | null => {
  const match = /^note:\/\/([A-Za-z0-9]{6})(?:#(\S*))?$/.exec(href);
  if (!match) return null;
  let fragment = match[2] ?? "";
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    /* A malformed escape stays literal text. */
  }
  const slug = text.slugify(fragment);
  return { noteId: match[1]!, anchor: slug ? `heading-${slug}` : null };
};

/** `#<anchor>` for a parsed note link, or nothing for the note's top. */
export const anchorHash = (anchor: string | null): string => (anchor ? `#${anchor}` : "");

/**
 * One-based line of the heading whose Book id is `id`, or null. The editor reads headings from the source, so the
 * text is the heading line with its link targets and inline markers left out, which slugs like Book's rendered text.
 */
export const headingAnchorLine = (markdown: string, id: string): number | null => {
  const used = new Set<string>();
  const literal = literalMarkdownLines(markdown);
  for (const [index, line] of markdown.split("\n").entries()) {
    if (literal.has(index)) continue;
    const heading = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const base = headingAnchor(heading.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1"));
    let candidate = base;
    for (let suffix = 2; used.has(candidate); suffix++) candidate = `${base}-${suffix}`;
    used.add(candidate);
    if (candidate === id) return index + 1;
  }
  return null;
};
