import type { MutationResult } from "@k2b/cloud/contracts";
import type { DateContext } from "@k2b/stdlib";
import { sql } from "bun";
import { buildNotePaths, type NotePathNode, noteSlug, parseNotePath } from "../lib/note-path";
import { createInitialNoteMarkdown, deriveNoteTitle, hasUsableNoteTitle } from "../lib/note-title";
import type * as activity from "./activity";
import { create, get, type Note } from "./notes";

type PathNode = NotePathNode;

export type NoteOutlineEntry = Pick<Note, "id" | "shortId" | "parentId" | "title" | "position" | "hasChildren" | "updatedAt"> & {
  parentShortId: string | null;
};

export type NotePathCandidate = { shortId: string; title: string; path: string };

export type NotePathProblem =
  | { kind: "invalid" }
  | { kind: "missing"; segment: string; parentPath: string }
  | { kind: "ambiguous"; segment: string; candidates: NotePathCandidate[] };

/**
 * The children of one note, without Markdown; the indexed level read stays bounded by that level. Slugs compare in
 * JavaScript, so they match `noteSlug` exactly whatever the database's locale does to case.
 */
export const childrenQuery = (notebookId: string, parentId: string | null) => {
  const parent = parentId === null ? sql`parent_id IS NULL` : sql`parent_id = ${parentId}::uuid`;
  return sql<{ id: string; short_id: string; parent_id: string | null; title: string }[]>`
    SELECT id, short_id, parent_id, title FROM notebooks.notes
    WHERE notebook_id = ${notebookId}::uuid AND ${parent}
    ORDER BY id
  `;
};

const childrenWithTitle = async (notebookId: string, parentId: string | null, title: string): Promise<PathNode[]> => {
  const slug = noteSlug(title);
  return (await childrenQuery(notebookId, parentId))
    .filter((row) => noteSlug(row.title) === slug)
    .map((row) => ({ id: row.id, shortId: row.short_id, parentId: row.parent_id, title: row.title }));
};

const candidatesOf = (nodes: PathNode[], parentPath: string): NotePathCandidate[] =>
  nodes.map((node) => ({ shortId: node.shortId, title: node.title, path: [parentPath, noteSlug(node.title)].filter(Boolean).join("/") }));

/** A relative create needs only its start node and ancestors to print canonical paths. */
const loadAncestors = async (notebookId: string, id: string): Promise<PathNode[]> => {
  const rows = await sql<{ id: string; short_id: string; parent_id: string | null; title: string }[]>`
    WITH RECURSIVE ancestors AS (
      SELECT id, short_id, parent_id, title FROM notebooks.notes
      WHERE notebook_id = ${notebookId}::uuid AND id = ${id}::uuid
      UNION
      SELECT n.id, n.short_id, n.parent_id, n.title FROM notebooks.notes n
      JOIN ancestors a ON n.id = a.parent_id WHERE n.notebook_id = ${notebookId}::uuid
    ) SELECT * FROM ancestors
  `;
  return rows.map((row) => ({ id: row.id, shortId: row.short_id, parentId: row.parent_id, title: row.title }));
};

type PathWalk =
  | { kind: "found"; node: PathNode | null; path: string }
  | { kind: "missing"; node: PathNode | null; path: string; index: number; problem: NotePathProblem }
  | { kind: "ambiguous"; problem: NotePathProblem };

const walkPath = async (notebookId: string, segments: string[], start: PathNode | null = null, startPath = ""): Promise<PathWalk> => {
  let node = start;
  let path = startPath;
  for (const [index, segment] of segments.entries()) {
    const matches = await childrenWithTitle(notebookId, node?.id ?? null, segment);
    if (matches.length === 0) return { kind: "missing", node, path, index, problem: { kind: "missing", segment, parentPath: path } };
    if (matches.length > 1) return { kind: "ambiguous", problem: { kind: "ambiguous", segment, candidates: candidatesOf(matches, path) } };
    node = matches[0]!;
    path = [path, noteSlug(node.title)].filter(Boolean).join("/");
  }
  return { kind: "found", node, path };
};

/** SQL pages contain only metadata; parents and child existence are indexed lookups for returned rows. */
export const outlinePageQuery = (params: { notebookId: string; pagination: { limit: number; offset: number } }) => sql<
  {
    id: string;
    short_id: string;
    parent_id: string | null;
    parent_short_id: string | null;
    title: string;
    position: number;
    updated_at: Date;
    has_children: boolean;
  }[]
>`
    WITH page AS MATERIALIZED (
      SELECT id, short_id, parent_id, title, position, updated_at FROM notebooks.notes
      WHERE notebook_id = ${params.notebookId}::uuid ORDER BY id
      LIMIT ${params.pagination.limit} OFFSET ${params.pagination.offset}
    )
    SELECT page.*, parent.short_id AS parent_short_id,
      EXISTS(SELECT 1 FROM notebooks.notes child WHERE child.parent_id = page.id) AS has_children
    FROM page LEFT JOIN notebooks.notes parent ON parent.id = page.parent_id AND parent.notebook_id = ${params.notebookId}::uuid
    ORDER BY page.id
  `;

export const listOutline = async (
  params: Parameters<typeof outlinePageQuery>[0],
): Promise<{ items: NoteOutlineEntry[]; total: number }> => {
  const rows = await outlinePageQuery(params);
  const [count] = await sql<{ total: number }[]>`
    SELECT COUNT(*)::int AS total FROM notebooks.notes WHERE notebook_id = ${params.notebookId}::uuid
  `;
  return {
    items: rows.map((row) => ({
      id: row.id,
      shortId: row.short_id,
      parentId: row.parent_id,
      parentShortId: row.parent_short_id,
      title: row.title,
      position: row.position,
      updatedAt: row.updated_at.toISOString(),
      hasChildren: row.has_children,
    })),
    total: count?.total ?? 0,
  };
};

/** Resolve a notebook-relative address path to exactly one note. */
export const resolvePath = async (params: {
  notebookId: string;
  path: string;
}): Promise<{ ok: true; note: Note; path: string } | { ok: false; problem: NotePathProblem }> => {
  const parsed = parseNotePath(params.path);
  if (!parsed.ok || parsed.segments.length === 0) return { ok: false, problem: { kind: "invalid" } };
  const resolution = await walkPath(params.notebookId, parsed.segments);
  if (resolution.kind !== "found") return { ok: false, problem: resolution.problem };
  const note = resolution.node ? await get({ id: resolution.node.id }) : null;
  if (!note) return { ok: false, problem: { kind: "missing", segment: parsed.segments.at(-1)!, parentPath: "" } };
  return { ok: true, note, path: resolution.path };
};

export type CreateAtPathResult =
  | { ok: true; note: Note }
  | { ok: false; problem: NotePathProblem }
  | { ok: false; problem: { kind: "title-exists"; title: string; candidates: NotePathCandidate[] } }
  | { ok: false; problem: { kind: "failed"; error: string; status: Extract<MutationResult<never>, { ok: false }>["status"] } };

/**
 * Create a note below `parentPath`, resolved relative to `parentId` (or the
 * notebook root). With `createParents`, missing path segments become notes
 * titled after the segment. A title that already exists among the target
 * siblings is refused: path addresses must stay unambiguous.
 */
export const createAtPath = async (params: {
  notebookId: string;
  parentId: string | null;
  parentPath: string;
  createParents: boolean;
  contentMd: string | undefined;
  position?: number;
  creatorId: string | null;
  actor?: activity.NotebookActivityIdentity;
  dateConfig?: DateContext;
}): Promise<CreateAtPathResult> => {
  const parsed = parseNotePath(params.parentPath);
  if (!parsed.ok) return { ok: false, problem: { kind: "invalid" } };
  const ancestors = params.parentId ? await loadAncestors(params.notebookId, params.parentId) : [];
  const start = ancestors.find((node) => node.id === params.parentId) ?? null;
  if (params.parentId && !start) return { ok: false, problem: { kind: "missing", segment: "", parentPath: "" } };
  const startPath = start ? (buildNotePaths(ancestors, { mirror: false }).get(start.id) ?? "") : "";
  const resolution = await walkPath(params.notebookId, parsed.segments, start, startPath);
  if (resolution.kind === "ambiguous") return { ok: false, problem: resolution.problem };
  let parentId = resolution.node?.id ?? null;
  const missing = resolution.kind === "missing" ? parsed.segments.slice(resolution.index) : [];
  if (resolution.kind === "missing" && !params.createParents) return { ok: false, problem: resolution.problem };

  if (missing.length === 0 && hasUsableNoteTitle(params.contentMd)) {
    const title = deriveNoteTitle(params.contentMd);
    const existing = await childrenWithTitle(params.notebookId, parentId, title);
    if (existing.length > 0)
      return { ok: false, problem: { kind: "title-exists", title, candidates: candidatesOf(existing, resolution.path) } };
  }

  const createNote = async (contentMd: string | undefined, position?: number) => {
    const result = await create({
      data: { notebookId: params.notebookId, parentId: parentId ?? undefined, contentMd, position },
      creatorId: params.creatorId,
      actor: params.actor,
      dateConfig: params.dateConfig,
    });
    if (result.ok) parentId = result.data.id;
    return result;
  };
  for (const segment of missing) {
    const folder = await createNote(createInitialNoteMarkdown(segment));
    if (!folder.ok) return { ok: false, problem: { kind: "failed", error: folder.error, status: folder.status } };
  }
  const created = await createNote(params.contentMd, params.position);
  if (!created.ok) return { ok: false, problem: { kind: "failed", error: created.error, status: created.status } };
  return { ok: true, note: created.data };
};
