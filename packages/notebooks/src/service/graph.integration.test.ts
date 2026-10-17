import { afterAll, beforeAll, expect, spyOn } from "bun:test";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { buildNotebookGraph, reindexLinks } from "./links";
import { create, getTree, type Note } from "./notes";
import * as workspaceEvents from "./workspace-events";

const postgresTest = testFor("database");
const notebookIds: string[] = [];

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

afterAll(async () => {
  if (!testInfra.database) return;
  for (const id of notebookIds) await sql`DELETE FROM notebooks.notebooks WHERE id = ${id}::uuid`;
});

const notebook = async () => {
  const id = crypto.randomUUID();
  const shortId = crypto.randomUUID().replaceAll("-", "").slice(0, 6);
  await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${id}::uuid, ${shortId}, 'Graph test')`;
  notebookIds.push(id);
  return id;
};

const newNote = async (notebookId: string, contentMd: string, parentId?: string, position?: number): Promise<Note> => {
  const result = await create({ data: { notebookId, contentMd, parentId, position }, creatorId: null, locale: "en" });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.data;
};

postgresTest("graph nodes retain hierarchy, integer positions, and ISO timestamps while edges stay inside the notebook", async () => {
  const created = spyOn(workspaceEvents, "noteCreated").mockResolvedValue(undefined);
  try {
    const notebookA = await notebook();
    const notebookB = await notebook();
    const area = await newNote(notebookA, "# Area");
    const outside = await newNote(notebookB, `# Outside\n\nnote://${area.shortId}`);
    const childOne = await newNote(notebookA, `# Child one\n\nnote://${area.shortId}\n\nnote://${outside.shortId}`, area.id);
    const childTwo = await newNote(notebookA, `# Child two\n\nnote://${area.shortId}`, area.id);
    const first = await newNote(notebookA, "# First");
    const second = await newNote(notebookA, "# Second");
    const third = await newNote(notebookA, "# Third", undefined, 0);
    const notes = [area, childOne, childTwo, first, second, third];

    for (const note of [outside, childOne, childTwo]) await reindexLinks(note.id, note.contentMd);
    await reindexLinks(first.id, `# First\n\nnote://${first.shortId}`);
    // Prove the cross-notebook links exist in the index before checking graph scoping.
    const crossLinks = await sql<{ source_note_id: string; target_note_id: string }[]>`
      SELECT source_note_id, target_note_id FROM notebooks.note_links
      WHERE source_note_id = ${outside.id}::uuid OR target_note_id = ${outside.id}::uuid
    `;
    expect(crossLinks).toHaveLength(2);

    const graph = await buildNotebookGraph({ notebookId: notebookA });
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(notes.map((note) => note.shortId).sort());
    const rows = await sql<{ short_id: string; parent_id: string | null; position: number; updated_at: Date }[]>`
      SELECT short_id, parent_id, position, updated_at FROM notebooks.notes WHERE notebook_id = ${notebookA}::uuid
    `;
    const tree = await getTree({ notebookId: notebookA, locale: "en" });
    const treeNotes = tree.flatMap((node) => [node, ...node.children]);
    for (const node of graph.nodes) {
      const row = rows.find((row) => row.short_id === node.id)!;
      const treeNote = treeNotes.find((note) => note.shortId === node.id)!;
      expect(node.title).toBe(treeNote.title);
      expect(node.parentId).toBe(row.parent_id === null ? null : area.shortId);
      expect(node.position).toBe(row.position);
      expect(node.position).toBe(treeNote.position);
      expect(typeof row.position).toBe("number");
      expect(typeof node.position).toBe("number");
      expect(Number.isInteger(node.position)).toBe(true);
      expect(node.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(node.updatedAt).toBe(row.updated_at.toISOString());
      expect(node.inDegree).toBe(node.id === area.shortId ? 2 : 0);
    }
    const topLevel = [third, area, first, second].map((note) => graph.nodes.find((node) => node.id === note.shortId)!);
    expect(topLevel.map((node) => node.parentId)).toEqual([null, null, null, null]);
    expect(topLevel.map((node) => node.position)).toEqual([1, 2, 3, 4]);
    for (const child of [childOne, childTwo]) {
      expect(graph.nodes.find((node) => node.id === child.shortId)?.parentId).toBe(area.shortId);
    }
    expect(graph.edges.toSorted((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))).toEqual(
      [childOne, childTwo]
        .map((note) => ({ source: note.shortId, target: area.shortId }))
        .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)),
    );
    expect(
      graph.edges.every((edge) => edge.source !== edge.target && edge.source !== outside.shortId && edge.target !== outside.shortId),
    ).toBe(true);
  } finally {
    created.mockRestore();
  }
});
