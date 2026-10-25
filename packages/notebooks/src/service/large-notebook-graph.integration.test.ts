import { afterAll, beforeAll, describe, expect } from "bun:test";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { type InsertedFixtureNotebook, insertFixtureNotebook } from "./large-notebook.test-fixture";
import { buildNotebookGraph, buildNotebookGraphView, GRAPH_AROUND_NOTES } from "./links";

const postgresTest = testFor("database");
let small: InsertedFixtureNotebook | undefined;
let large: InsertedFixtureNotebook | undefined;

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrate();
  [small, large] = await Promise.all([insertFixtureNotebook("small"), insertFixtureNotebook("large")]);
}, 120_000);

afterAll(async () => {
  await small?.remove();
  await large?.remove();
});

const timed = async <T>(run: () => Promise<T>) => {
  await run();
  const started = performance.now();
  const value = await run();
  return { value, ms: performance.now() - started };
};

describe("the Links graph of a 20,000-page notebook", () => {
  postgresTest("a small notebook still draws whole, without a scope", async () => {
    const view = await buildNotebookGraphView({ notebookId: small!.id, noteId: small!.page.id });
    expect(view.scope).toBeUndefined();
    expect(view).toEqual(await buildNotebookGraph({ notebookId: small!.id }));
  });

  postgresTest("a large one draws the bounded pages around one page, about as fast as a small one", async () => {
    const notebook = large!;
    const base = await timed(() => buildNotebookGraphView({ notebookId: small!.id, noteId: small!.page.id }));
    for (const around of [notebook.page, notebook.folder, { id: notebook.notes[0]!.id, shortId: notebook.notes[0]!.shortId }]) {
      const { value: view, ms } = await timed(() => buildNotebookGraphView({ notebookId: notebook.id, noteId: around.id }));
      console.info(JSON.stringify({ around: around.shortId, nodes: view.nodes.length, edges: view.edges.length, ms: Math.round(ms) }));
      expect(view.scope).toEqual({ around: around.shortId, total: 20_000 });
      // The pages around it plus their way up the tree, never the notebook.
      expect(view.nodes.length).toBeLessThanOrEqual(GRAPH_AROUND_NOTES + 5 * GRAPH_AROUND_NOTES);
      expect(view.nodes.length).toBeLessThan(2500);
      expect(view.nodes.some((node) => node.id === around.shortId)).toBe(true);
      const ids = new Set(view.nodes.map((node) => node.id));
      expect(view.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
      // Every node's parent is part of the graph, so areas and depths read as in the whole graph.
      expect(view.nodes.every((node) => node.parentId === null || ids.has(node.parentId))).toBe(true);
      expect(ms).toBeLessThan(base.ms * 5 + 400);
    }
    // The folder of 5,000 pages shows a bounded part of its sub-pages.
    const folder = await buildNotebookGraphView({ notebookId: notebook.id, noteId: notebook.folder.id });
    expect(folder.nodes.filter((node) => node.parentId === notebook.folder.shortId).length).toBeLessThanOrEqual(GRAPH_AROUND_NOTES);
  });
});
