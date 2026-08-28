/**
 * Inline `#tag` extraction + index management.
 *
 * Tags live in the markdown body — `#topic`, `#project/notebooks`, etc.
 * They're indexed into `notebooks.note_tags` on every note save so
 * notebook-wide aggregations (tag-overview, autocomplete, search) stay
 * O(log N) instead of full content_md scans.
 *
 * Disambiguation from markdown headings: `# Title` (with space after `#`)
 * is a heading; `#tag` (no space, must start with a letter) is a tag.
 */
import { sql } from "bun";
import { notebookServiceMessages } from "./messages";

/** `(?:^|\s)` ensures we only match `#tag` at line-start or after whitespace,
 *  never inside a word. The `[a-zA-Z]` first-char rule excludes numerals
 *  (`#1` is not a tag) and `#` repetition (`##` headings). Nesting via `/`. */
const TAG_REGEX = /(?:^|\s)#([a-zA-Z][\w-]*(?:\/[\w-]+)*)/g;

/** Strip fenced + inline code so we don't extract tags from documentation
 *  about the tag syntax or from `#define` C macros etc. inside code blocks. */
const stripCodeBlocks = (md: string): string => md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "");

/** Extract every unique tag (lowercased) referenced from a markdown body. */
export const extractTags = (md: string | null): string[] => {
  if (!md) return [];
  const stripped = stripCodeBlocks(md);
  const tags = new Set<string>();
  for (const m of stripped.matchAll(TAG_REGEX)) tags.add(m[1]!.toLowerCase());
  return Array.from(tags);
};

/**
 * Replace the index rows for one note. Single transaction — a partial
 * apply would leave the index in an inconsistent state and is worse than
 * leaving the previous (slightly stale) state intact.
 */
export const reindexTags = async (params: { noteId: string; notebookId: string; contentMd: string | null }): Promise<void> => {
  const tags = extractTags(params.contentMd);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM notebooks.note_tags WHERE note_id = ${params.noteId}`;
    if (tags.length === 0) return;
    const rows = tags.map((tag) => [params.noteId, params.notebookId, tag] as const);
    await tx`
      INSERT INTO notebooks.note_tags ${tx(rows.map(([note_id, notebook_id, tag]) => ({ note_id, notebook_id, tag })))}
      ON CONFLICT DO NOTHING
    `;
  });
};

export type TagSummary = {
  tag: string;
  count: number;
};

/** All tags in a notebook with their note-count. Drives the tag-overview
 *  page and the `/tag` slash-command picker. */
export const listForNotebook = async (params: {
  notebookId: string;
  pagination?: { limit: number; offset: number };
}): Promise<TagSummary[]> => {
  const limit = params.pagination?.limit ?? null;
  const offset = params.pagination?.offset ?? 0;
  const rows = await sql<{ tag: string; count: number }[]>`
    SELECT tag, COUNT(*)::int AS count
    FROM notebooks.note_tags
    WHERE notebook_id = ${params.notebookId}
    GROUP BY tag
    ORDER BY count DESC, tag ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return rows;
};

export type TaggedNote = {
  id: string;
  shortId: string;
  title: string;
  preview: string | null;
  updatedAt: string;
};

/** Limit on preview length — keeps the SSR payload small and matches
 *  the visual line-clamp on the cards. */
const PREVIEW_CHARS = 240;

/** Strip frontmatter + heading markers + code fences from a markdown
 *  body so the preview reads like prose. KISS — full markdown→text
 *  parsing would be overkill for a 240-char snippet. */
const buildPreview = (md: string | null): string | null => {
  if (!md) return null;
  let stripped = md;
  // Drop YAML/TOML frontmatter at the head of the doc
  stripped = stripped.replace(/^---[\s\S]*?\n---\n/, "");
  // Strip fenced code blocks entirely (they read poorly out of context)
  stripped = stripped.replace(/```[\s\S]*?```/g, "");
  // Drop heading markers but keep the heading text (gives context)
  stripped = stripped.replace(/^#{1,6}\s+/gm, "");
  // Collapse whitespace
  stripped = stripped.replace(/\s+/g, " ").trim();
  if (stripped.length === 0) return null;
  return stripped.length > PREVIEW_CHARS ? `${stripped.slice(0, PREVIEW_CHARS - 1)}…` : stripped;
};

/** Notes within a notebook that reference a given tag. Notebook-level
 *  access gating happens at the page handler — all notes in a readable
 *  notebook are visible.
 *
 *  Optional `search` does a case-insensitive substring match against the
 *  title and the (already-stored) markdown body; results are paginated. */
export const listNotesForTag = async (params: {
  notebookId: string;
  tag: string;
  search?: string;
  pagination?: { limit: number; offset: number };
}): Promise<{ items: TaggedNote[]; total: number }> => {
  const q = params.search?.trim().toLowerCase();
  const pattern = q && q.length > 0 ? `%${q}%` : null;
  const limit = params.pagination?.limit ?? 50;
  const offset = params.pagination?.offset ?? 0;

  const rows = await sql<{ id: string; short_id: string; title: string; content_md: string | null; updated_at: Date | string }[]>`
    SELECT n.id, n.short_id, n.title, n.content_md, n.updated_at
    FROM notebooks.note_tags t
    JOIN notebooks.notes n ON n.id = t.note_id
    WHERE t.notebook_id = ${params.notebookId}
      AND t.tag = ${params.tag.toLowerCase()}
      AND (
        ${pattern}::text IS NULL
        OR LOWER(n.title) LIKE ${pattern}
        OR LOWER(n.content_md) LIKE ${pattern}
      )
    ORDER BY n.updated_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  const [countRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM notebooks.note_tags t
    JOIN notebooks.notes n ON n.id = t.note_id
    WHERE t.notebook_id = ${params.notebookId}
      AND t.tag = ${params.tag.toLowerCase()}
      AND (
        ${pattern}::text IS NULL
        OR LOWER(n.title) LIKE ${pattern}
        OR LOWER(n.content_md) LIKE ${pattern}
      )
  `;

  return {
    items: rows.map((r) => ({
      id: r.id,
      shortId: r.short_id,
      title: r.title,
      preview: buildPreview(r.content_md),
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
    })),
    total: countRow?.count ?? 0,
  };
};

/** Total notes-with-this-tag (unfiltered), for the page-header count. */
export const countNotesForTag = async (params: { notebookId: string; tag: string }): Promise<number> => {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM notebooks.note_tags
    WHERE notebook_id = ${params.notebookId}
      AND tag = ${params.tag.toLowerCase()}
  `;
  return row?.count ?? 0;
};

/** Total distinct tags in a notebook — gates the sidebar "Tags" link. */
export const count = async (params: { notebookId: string }): Promise<number> => {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(DISTINCT tag)::int AS count
    FROM notebooks.note_tags
    WHERE notebook_id = ${params.notebookId}
  `;
  return row?.count ?? 0;
};

// =============================================================================
// HTML post-processor — wraps `#tag` references in rendered read-mode
// HTML as clickable pills. Mirrors the editor's `cm-tag-pill` styling so
// edit and read modes look identical.
// =============================================================================

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const TAG_HTML_REGEX = /(^|\s|>)#([a-zA-Z][\w-]*(?:\/[\w-]+)*)/g;

const renderPill = (notebookId: string, tag: string, locale?: string): string => {
  const title = notebookServiceMessages.resolve(locale ? [locale] : []).t.showNotesWithTag({ tag });
  const href = `/app/notebooks/${notebookId}/tags/${encodeURIComponent(tag)}`;
  return `<a href="${href}" class="cm-tag-pill inline-flex items-center px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 no-underline align-baseline font-medium" title="${escapeHtml(title)}">#${escapeHtml(tag)}</a>`;
};

/** Wrap `#tag` references in HTML as pill anchors — but skip content
 *  inside `<code>` and `<pre>` blocks so doc snippets don't get mangled.
 *  Walks the HTML segment-by-segment, leaving code blocks untouched. */
export const transformTags = (html: string, params: { notebookId: string; locale?: string }): string => {
  const transformText = (text: string): string =>
    text.replace(TAG_HTML_REGEX, (_match, prefix: string, tag: string) =>
      `${prefix}${renderPill(params.notebookId, tag.toLowerCase(), params.locale)}`);

  // Split on opening `<pre>` / `<code>` tags so we can walk the HTML
  // without parsing — content inside these blocks is copied verbatim.
  let result = "";
  let cursor = 0;
  const open = /<(pre|code)\b[^>]*>/gi;
  let openMatch = open.exec(html);
  while (openMatch !== null) {
    // Transform the text leading up to the open tag.
    result += transformText(html.slice(cursor, openMatch.index));

    const tagName = openMatch[1]!.toLowerCase();
    const close = new RegExp(`</${tagName}>`, "gi");
    close.lastIndex = openMatch.index + openMatch[0].length;
    const closeMatch = close.exec(html);
    if (!closeMatch) {
      // Unmatched open tag → copy rest verbatim, don't transform.
      result += html.slice(openMatch.index);
      cursor = html.length;
      break;
    }
    // Copy the entire `<code>...</code>` (or `<pre>...</pre>`) verbatim.
    const blockEnd = closeMatch.index + closeMatch[0].length;
    result += html.slice(openMatch.index, blockEnd);
    cursor = blockEnd;
    open.lastIndex = blockEnd;
    openMatch = open.exec(html);
  }
  // Transform the trailing text after the last code block.
  result += transformText(html.slice(cursor));
  return result;
};
