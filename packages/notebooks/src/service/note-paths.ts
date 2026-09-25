import type { MutationResult } from "@k2b/cloud/contracts";
import type { DateContext } from "@k2b/stdlib";
import { sql } from "bun";
import {
  buildNotePaths,
  type NotePathNode,
  type NotePathResolution,
  parseNotePath,
  resolveNotePath,
  siblingsWithTitle,
} from "../lib/note-path";
import { createInitialNoteMarkdown, deriveNoteTitle, hasUsableNoteTitle } from "../lib/note-title";
import type * as activity from "./activity";
import { create, get, type Note } from "./notes";

type PathNode = NotePathNode & { updatedAt: string };

export type NoteOutlineEntry = Pick<Note, "id" | "shortId" | "parentId" | "title" | "hasChildren" | "updatedAt">;

export type NotePathCandidate = { shortId: string; title: string; path: string };

export type NotePathProblem =
  | { kind: "invalid" }
  | { kind: "missing"; segment: string; parentPath: string }
  | { kind: "ambiguous"; segment: string; candidates: NotePathCandidate[] };

/** One lightweight row per note; no Markdown is loaded. */
const loadNodes = async (notebookId: string): Promise<PathNode[]> => {
  const rows = await sql<{ id: string; short_id: string; parent_id: string | null; title: string; updated_at: Date }[]>`
    SELECT id, short_id, parent_id, title, updated_at
    FROM notebooks.notes
    WHERE notebook_id = ${notebookId}::uuid
  `;
  return rows.map((row) => ({
    id: row.id,
    shortId: row.short_id,
    parentId: row.parent_id,
    title: row.title,
    updatedAt: row.updated_at.toISOString(),
  }));
};

const candidatesOf = (nodes: PathNode[], paths: Map<string, string>): NotePathCandidate[] =>
  nodes.map((node) => ({ shortId: node.shortId, title: node.title, path: paths.get(node.id) ?? "" }));

const problemFor = (resolution: NotePathResolution<PathNode>, segments: string[], paths: Map<string, string>): NotePathProblem | null => {
  if (resolution.kind === "ambiguous")
    return { kind: "ambiguous", segment: segments[resolution.index]!, candidates: candidatesOf(resolution.candidates, paths) };
  if (resolution.kind === "missing")
    return {
      kind: "missing",
      segment: segments[resolution.index]!,
      parentPath: resolution.parent ? (paths.get(resolution.parent.id) ?? "") : "",
    };
  return null;
};

/** Every note without content, in stable ID order, for bounded paging. */
export const listOutline = async (params: { notebookId: string }): Promise<NoteOutlineEntry[]> => {
  const nodes = await loadNodes(params.notebookId);
  const parents = new Set(nodes.map((node) => node.parentId));
  return nodes.map((node) => ({ ...node, hasChildren: parents.has(node.id) })).sort((left, right) => left.id.localeCompare(right.id));
};

/** Resolve a notebook-relative address path to exactly one note. */
export const resolvePath = async (params: {
  notebookId: string;
  path: string;
}): Promise<{ ok: true; note: Note; path: string } | { ok: false; problem: NotePathProblem }> => {
  const parsed = parseNotePath(params.path);
  if (!parsed.ok || parsed.segments.length === 0) return { ok: false, problem: { kind: "invalid" } };
  const nodes = await loadNodes(params.notebookId);
  const paths = buildNotePaths(nodes, { mirror: false });
  const resolution = resolveNotePath(nodes, parsed.segments);
  const problem = problemFor(resolution, parsed.segments, paths);
  if (problem) return { ok: false, problem };
  const node = resolution.kind === "found" ? resolution.node : null;
  const note = node ? await get({ id: node.id }) : null;
  if (!note) return { ok: false, problem: { kind: "missing", segment: parsed.segments.at(-1)!, parentPath: "" } };
  return { ok: true, note, path: paths.get(note.id) ?? "" };
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
  creatorId: string | null;
  actor?: activity.NotebookActivityIdentity;
  dateConfig?: DateContext;
}): Promise<CreateAtPathResult> => {
  const parsed = parseNotePath(params.parentPath);
  if (!parsed.ok) return { ok: false, problem: { kind: "invalid" } };
  const nodes = await loadNodes(params.notebookId);
  if (params.parentId && !nodes.some((node) => node.id === params.parentId))
    return { ok: false, problem: { kind: "missing", segment: "", parentPath: "" } };
  const paths = buildNotePaths(nodes, { mirror: false });
  const resolution = resolveNotePath(nodes, parsed.segments, params.parentId);
  if (resolution.kind === "ambiguous") return { ok: false, problem: problemFor(resolution, parsed.segments, paths)! };

  let parentId = resolution.kind === "found" ? (resolution.node?.id ?? null) : (resolution.parent?.id ?? null);
  const missing = resolution.kind === "missing" ? parsed.segments.slice(resolution.index) : [];
  if (missing.length > 0 && !params.createParents) return { ok: false, problem: problemFor(resolution, parsed.segments, paths)! };

  if (missing.length === 0 && hasUsableNoteTitle(params.contentMd)) {
    const title = deriveNoteTitle(params.contentMd);
    const existing = siblingsWithTitle(nodes, parentId, title);
    if (existing.length > 0) return { ok: false, problem: { kind: "title-exists", title, candidates: candidatesOf(existing, paths) } };
  }

  const createNote = async (contentMd: string | undefined) => {
    const result = await create({
      data: { notebookId: params.notebookId, parentId: parentId ?? undefined, contentMd },
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
  const created = await createNote(params.contentMd);
  if (!created.ok) return { ok: false, problem: { kind: "failed", error: created.error, status: created.status } };
  return { ok: true, note: created.data };
};
