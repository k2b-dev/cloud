import { sql } from "bun";
import { compareNoteOrder } from "../lib/note-order";
import { SIDEBAR_FIRST_ROWS, SIDEBAR_MAX_WINDOW, SIDEBAR_PAGE_SIZE, type SidebarTreeSort } from "../lib/sidebar-tree";

/**
 * The note tree, one level at a time. A notebook can hold tens of thousands of
 * notes, so the sidebar never loads the whole tree: it reads the levels a
 * person opened, a window of rows at a time, without Markdown. A level read
 * costs its own siblings, never the rest of the notebook.
 */

export type TreeSort = SidebarTreeSort;

export type TreeEntry = {
  id: string;
  shortId: string;
  parentId: string | null;
  title: string;
  position: number;
  hasChildren: boolean;
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
};

export type TreeLevelWindow = {
  parentId: string | null;
  total: number;
  offset: number;
  items: TreeEntry[];
};

/** A notebook this small loads whole and opens every branch, as a short tree reads best at a glance. */
export const SMALL_TREE_NOTES = SIDEBAR_PAGE_SIZE;

type DbTreeEntry = {
  id: string;
  short_id: string;
  parent_id: string | null;
  title: string;
  position: number;
  has_children: boolean;
  created_at: Date;
  updated_at: Date;
  locked_at: Date | null;
};

const toEntry = (row: DbTreeEntry): TreeEntry => ({
  id: row.id,
  shortId: row.short_id,
  parentId: row.parent_id,
  title: row.title,
  position: row.position,
  hasChildren: row.has_children,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  lockedAt: row.locked_at?.toISOString() ?? null,
});

const byDate = (field: "createdAt" | "updatedAt") => (left: TreeEntry, right: TreeEntry) =>
  right[field].localeCompare(left[field]) || left.title.localeCompare(right.title) || left.shortId.localeCompare(right.shortId);

/** One level in the order on screen: the notebook order or newest first, the homepage leading its own level. */
export const sortLevel = (entries: TreeEntry[], sort: TreeSort, locale: string, homepageId: string | null): TreeEntry[] => {
  const sorted = [...entries].sort(
    sort === "title"
      ? compareNoteOrder(locale, (entry: TreeEntry) => entry.shortId)
      : byDate(sort === "created" ? "createdAt" : "updatedAt"),
  );
  const home = homepageId ? sorted.findIndex((entry) => entry.id === homepageId) : -1;
  if (home > 0) sorted.unshift(...sorted.splice(home, 1));
  return sorted;
};

const selectEntries = sql`
  SELECT
    n.id, n.short_id, n.parent_id, n.title, n.position, n.created_at, n.updated_at, n.locked_at,
    EXISTS(SELECT 1 FROM notebooks.notes child WHERE child.parent_id = n.id) AS has_children
  FROM notebooks.notes n
`;

/** Every note of one level, without Markdown, in the order on screen. */
export const readLevel = async (params: {
  notebookId: string;
  parentId: string | null;
  sort: TreeSort;
  locale: string;
  homepageId: string | null;
}): Promise<TreeEntry[]> => {
  // Separate predicates let the (notebook_id, parent_id, position) index serve both the top level and a branch.
  const rows =
    params.parentId === null
      ? await sql<DbTreeEntry[]>`${selectEntries} WHERE n.notebook_id = ${params.notebookId}::uuid AND n.parent_id IS NULL`
      : await sql<
          DbTreeEntry[]
        >`${selectEntries} WHERE n.notebook_id = ${params.notebookId}::uuid AND n.parent_id = ${params.parentId}::uuid`;
  return sortLevel(rows.map(toEntry), params.sort, params.locale, params.homepageId);
};

/** The window of rows starting at `offset`, or the page that holds `around` when it sits in this level. */
export const levelWindow = (
  parentId: string | null,
  level: TreeEntry[],
  window: { offset?: number; limit?: number; around?: string },
): TreeLevelWindow => {
  const limit = Math.min(SIDEBAR_MAX_WINDOW, Math.max(1, window.limit ?? SIDEBAR_PAGE_SIZE));
  const at = window.around ? level.findIndex((entry) => entry.id === window.around) : -1;
  const offset = at >= 0 ? Math.floor(at / limit) * limit : Math.min(Math.max(0, window.offset ?? 0), level.length);
  return { parentId, total: level.length, offset, items: level.slice(offset, offset + limit) };
};

/** The notes above one note, from the top level down to its parent. Bounded by the tree's depth. */
export const ancestorIds = async (noteId: string): Promise<string[]> => {
  const rows = await sql<{ id: string }[]>`
    WITH RECURSIVE chain AS (
      SELECT parent_id AS id, 1 AS depth FROM notebooks.notes WHERE id = ${noteId}::uuid
      UNION ALL
      SELECT n.parent_id, chain.depth + 1 FROM notebooks.notes n JOIN chain ON n.id = chain.id
      WHERE chain.id IS NOT NULL AND chain.depth < 256
    )
    SELECT id FROM chain WHERE id IS NOT NULL ORDER BY depth DESC
  `;
  return rows.map((row) => row.id);
};

export const countNotes = async (notebookId: string): Promise<number> => {
  const [row] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM notebooks.notes WHERE notebook_id = ${notebookId}::uuid`;
  return row?.count ?? 0;
};

/**
 * The levels that show one note: the top level and every level on its way
 * down, each as the window that holds the next step. `expandedIds` are the
 * notes that open on the way.
 */
export const revealNote = async (params: {
  notebookId: string;
  noteId: string;
  sort: TreeSort;
  locale: string;
  homepageId: string | null;
}): Promise<{ levels: TreeLevelWindow[]; expandedIds: string[] }> => {
  const ancestors = await ancestorIds(params.noteId);
  const parents = [null, ...ancestors];
  const path = [...ancestors, params.noteId];
  const levels = await Promise.all(
    parents.map(async (parentId, depth) =>
      levelWindow(parentId, await readLevel({ ...params, parentId }), { around: path[depth], limit: SIDEBAR_FIRST_ROWS }),
    ),
  );
  return { levels, expandedIds: ancestors };
};

/** A small notebook whole: every level complete, every branch open. */
export const readSmallTree = async (params: {
  notebookId: string;
  sort: TreeSort;
  locale: string;
  homepageId: string | null;
}): Promise<{ levels: TreeLevelWindow[]; expandedIds: string[] }> => {
  const rows = await sql<DbTreeEntry[]>`${selectEntries} WHERE n.notebook_id = ${params.notebookId}::uuid LIMIT ${SMALL_TREE_NOTES + 1}`;
  const byParent = new Map<string | null, TreeEntry[]>([[null, []]]);
  for (const entry of rows.map(toEntry)) byParent.set(entry.parentId, [...(byParent.get(entry.parentId) ?? []), entry]);
  const levels = [...byParent].map(([parentId, entries]) => {
    const level = sortLevel(entries, params.sort, params.locale, params.homepageId);
    return { parentId, total: level.length, offset: 0, items: level };
  });
  return { levels, expandedIds: [...byParent.keys()].filter((id): id is string => id !== null) };
};

export type TreeListView = "favorites" | "recents" | "tag";
export type TreeListEntry = TreeEntry & { tags: string[] };

/** How many notes Recent lists: as many as **Recently edited** on the Notebooks start page. */
export const RECENT_NOTE_LIMIT = 12;

/**
 * The notes of a sidebar filter, newest first: the person's favorites, the
 * most recently changed notes or the notes with one tag.
 */
export const listFiltered = async (params: {
  notebookId: string;
  userId: string;
  view: TreeListView;
  tag?: string;
  offset: number;
  limit: number;
}): Promise<{ total: number; items: TreeListEntry[] }> => {
  const recents = params.view === "recents";
  const limit = recents ? Math.min(params.limit, RECENT_NOTE_LIMIT) : params.limit;
  const offset = recents ? 0 : params.offset;
  // Favorites and tags start from their own indexed rows, so a filter costs its matches, not the notebook.
  const source =
    params.view === "favorites"
      ? sql`notebooks.note_favorites f JOIN notebooks.notes n ON n.id = f.note_id
          WHERE f.user_id = ${params.userId}::uuid AND f.notebook_id = ${params.notebookId}::uuid`
      : params.view === "tag"
        ? sql`notebooks.note_tags t JOIN notebooks.notes n ON n.id = t.note_id
            WHERE t.notebook_id = ${params.notebookId}::uuid AND t.tag = ${params.tag ?? ""}`
        : sql`notebooks.notes n WHERE n.notebook_id = ${params.notebookId}::uuid`;
  // The page is read first and only its rows ask for sub-notes and tags, so the planner never hashes those indexes
  // for the whole table.
  const rows = await sql<(DbTreeEntry & { tags: string[] })[]>`
    WITH page AS MATERIALIZED (
      SELECT n.id, n.short_id, n.parent_id, n.title, n.position, n.created_at, n.updated_at, n.locked_at
      FROM ${source}
      ORDER BY n.updated_at DESC, n.title, n.short_id
      LIMIT ${limit} OFFSET ${offset}
    )
    SELECT page.*,
      EXISTS(SELECT 1 FROM notebooks.notes child WHERE child.parent_id = page.id) AS has_children,
      ARRAY(SELECT nt.tag FROM notebooks.note_tags nt WHERE nt.note_id = page.id ORDER BY nt.tag) AS tags
    FROM page
    ORDER BY page.updated_at DESC, page.title, page.short_id
  `;
  const [count] = recents ? [{ count: rows.length }] : await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM ${source}`;
  return { total: count?.count ?? 0, items: rows.map((row) => ({ ...toEntry(row), tags: row.tags })) };
};

/** Internal IDs of the notes with these public IDs in one notebook; IDs of other notebooks are left out. */
export const resolveNotebookNoteIds = async (notebookId: string, shortIds: string[]): Promise<Map<string, string>> => {
  const unique = [...new Set(shortIds)];
  if (unique.length === 0) return new Map();
  const rows = await sql<{ id: string; short_id: string }[]>`
    SELECT id, short_id FROM notebooks.notes
    WHERE notebook_id = ${notebookId}::uuid AND short_id = ANY(${sql.array(unique, "TEXT")})
  `;
  return new Map(rows.map((row) => [row.short_id, row.id]));
};

export type TitleTreeNode = { shortId: string; title: string; position: number; children: TitleTreeNode[] };

/**
 * Every note's title and place, without Markdown, for the Book's reading order. It still grows with the notebook;
 * the sidebar never uses it.
 */
export const readTitleTree = async (notebookId: string): Promise<TitleTreeNode[]> => {
  const rows = await sql<{ id: string; short_id: string; parent_id: string | null; title: string; position: number }[]>`
    SELECT id, short_id, parent_id, title, position FROM notebooks.notes WHERE notebook_id = ${notebookId}::uuid
  `;
  const nodes = new Map(
    rows.map((row) => [row.id, { shortId: row.short_id, title: row.title, position: row.position, children: [] as TitleTreeNode[] }]),
  );
  const roots: TitleTreeNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parent_id ? nodes.get(row.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
};
