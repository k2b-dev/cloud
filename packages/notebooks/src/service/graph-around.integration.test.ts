import { afterAll, beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { migrate } from "../migrate";
import { buildNotebookGraphAround, GRAPH_AROUND_NOTES } from "./links";

const postgresTest = testFor("database");
const notebookIds: string[] = [];

/** A notebook of the given notes, each `[key, parentKey]`; keys become stable IDs in that notebook. */
const notebook = async (name: string, notes: Array<[string, string | null]>, links: Array<[string, string]>) => {
  const id = crypto.randomUUID();
  notebookIds.push(id);
  const uuid = new Map(notes.map(([key]) => [key, crypto.randomUUID()]));
  await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${id}::uuid, ${testShortId()}, ${name})`;
  // Parents first, so every parent exists before its children.
  const depth = (key: string): number => {
    const parent = notes.find(([entry]) => entry === key)?.[1] ?? null;
    return parent === null ? 0 : depth(parent) + 1;
  };
  const ordered = [...notes].sort((left, right) => depth(left[0]) - depth(right[0]));
  for (let start = 0; start < ordered.length; start += 1000) {
    const batch = ordered.slice(start, start + 1000);
    await sql`
      INSERT INTO notebooks.notes (id, short_id, notebook_id, parent_id, title, content_md)
      SELECT id, short_id, ${id}::uuid, NULLIF(parent, '')::uuid, title, ''
      FROM unnest(
        ${sql.array(
          batch.map(([key]) => uuid.get(key)!),
          "UUID",
        )},
        ${sql.array(
          batch.map(() => testShortId()),
          "TEXT",
        )},
        ${sql.array(
          batch.map(([, parent]) => (parent ? uuid.get(parent)! : "")),
          "TEXT",
        )},
        ${sql.array(
          batch.map(([key]) => key),
          "TEXT",
        )}
      ) AS input(id, short_id, parent, title)
    `;
  }
  for (let start = 0; start < links.length; start += 5000) {
    const batch = links.slice(start, start + 5000);
    await sql`
      INSERT INTO notebooks.note_links (source_note_id, target_note_id)
      SELECT * FROM unnest(
        ${sql.array(
          batch.map(([source]) => uuid.get(source)!),
          "UUID",
        )},
        ${sql.array(
          batch.map(([, target]) => uuid.get(target)!),
          "UUID",
        )}
      )
    `;
  }
  const graph = (key: string) => buildNotebookGraphAround({ notebookId: id, noteId: uuid.get(key)!, total: notes.length });
  return { graph };
};

const range = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

/** Every node's parent is in the graph, so areas and depths read as in the whole graph. */
const expectWholeWaysUp = (nodes: Array<{ id: string; parentId: string | null }>) => {
  const ids = new Set(nodes.map((node) => node.id));
  expect(nodes.filter((node) => node.parentId !== null && !ids.has(node.parentId))).toEqual([]);
};

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
});

afterAll(async () => {
  if (notebookIds.length > 0) await sql`DELETE FROM notebooks.notebooks WHERE id = ANY(${sql.array(notebookIds, "UUID")})`;
});

describe("the graph around one page stays bounded for every tree shape", () => {
  postgresTest("pages that each sit at the end of their own long way up count those ways toward the bound", async () => {
    // 450 linked pages, each three levels down a branch of its own: 1,800 pages with their ways up.
    const notes: Array<[string, string | null]> = [["Center", null]];
    for (const leaf of range(450)) {
      notes.push([`P${leaf}-1`, null], [`P${leaf}-2`, `P${leaf}-1`], [`P${leaf}-3`, `P${leaf}-2`], [`L${leaf}`, `P${leaf}-3`]);
    }
    const { graph } = await notebook(
      "Long ways up",
      notes,
      range(450).map((leaf) => ["Center", `L${leaf}`]),
    );
    const view = await graph("Center");
    expect(view.nodes.length).toBeLessThanOrEqual(GRAPH_AROUND_NOTES);
    // Each linked page brings its three parents: about a quarter of the bound are linked pages.
    expect(view.nodes.filter((node) => node.title.startsWith("L")).length).toBe(Math.floor((GRAPH_AROUND_NOTES - 1) / 4));
    expectWholeWaysUp(view.nodes);
  });

  postgresTest("a page 100 levels deep shows its whole way up", async () => {
    const notes: Array<[string, string | null]> = range(100).map((level) => [`D${level}`, level === 1 ? null : `D${level - 1}`]);
    const { graph } = await notebook("Deep", notes, []);
    const view = await graph("D100");
    expect(view.nodes).toHaveLength(100);
    expectWholeWaysUp(view.nodes);
  });

  postgresTest("pages already in the graph leave room for the next pages linked with them", async () => {
    // 200 pages linked with the open one and with each other, and 300 more linked with them.
    const notes: Array<[string, string | null]> = [["Center", null], ...range(200).map((a): [string, null] => [`A${a}`, null])];
    notes.push(...range(300).map((b): [string, null] => [`B${b}`, null]));
    const links: Array<[string, string]> = range(200).map((a) => ["Center", `A${a}`]);
    for (const a of range(200)) for (const other of range(200)) if (a !== other) links.push([`A${a}`, `A${other}`]);
    for (const b of range(300)) links.push([`A${((b - 1) % 200) + 1}`, `B${b}`]);
    const { graph } = await notebook("Linked", notes, links);
    const view = await graph("Center");
    expect(view.nodes).toHaveLength(GRAPH_AROUND_NOTES);
    expect(view.nodes.filter((node) => node.title.startsWith("B")).length).toBe(GRAPH_AROUND_NOTES - 201);
  });
});
