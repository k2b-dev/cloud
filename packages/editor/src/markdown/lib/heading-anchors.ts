import { text } from "@k2b/stdlib";

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
 * One-based line of `markdown` where Book's heading `id` starts, read from a Book rendering of that note, or null.
 * The rendering may be older than `markdown`: its line counts only while that line still holds the same text.
 */
export const renderedHeadingLine = (
  rendered: { markdown: string; headings: ReadonlyArray<{ id: string; line: number }> },
  id: string,
  markdown: string,
): number | null => {
  const line = rendered.headings.find((heading) => heading.id === id)?.line;
  if (line === undefined) return null;
  const source = rendered.markdown.split("\n")[line - 1];
  return source !== undefined && markdown.split("\n")[line - 1] === source ? line : null;
};
