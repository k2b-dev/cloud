import { describe, expect, test } from "bun:test";
import type { NoteGraph } from "../../../../service/links";
import { FIXTURE_NOW, HANDBOOK_IDS, handbookGraph, unlinkedGraph } from "./graph.fixtures";
import { buildGraphModel, matchesQuery, TOP_LEVEL_AREA, visibleEdges, visibleNotes } from "./model";

const model = buildGraphModel(handbookGraph(), "en");
describe("graph model", () => {
  test("ports the handbook tree, areas and directed links", () => {
    expect(model.notes).toHaveLength(49);
    expect(model.edges).toHaveLength(97);
    expect(model.areas.map((area) => [area.title, area.count, area.slot])).toEqual([
      [null, 6, 0],
      ["Wareneingang", 8, 1],
      ["Kommissionierung", 7, 2],
      ["Versand", 8, 3],
      ["Inventur 2026", 6, 4],
      ["Sicherheit", 7, 5],
      ["Onboarding", 7, 6],
    ]);
    expect(model.areas[0]?.key).toBe(TOP_LEVEL_AREA);
    expect(model.notes.slice(0, 4).map((note) => note.title)).toEqual([
      "Startseite",
      "Wareneingang",
      "Anlieferung anmelden",
      "Annahme prüfen",
    ]);
    const start = model.byId.get(HANDBOOK_IDS.start ?? "");
    expect(start?.out.size).toBe(10);
    expect(start?.in.size).toBe(0);
    expect(start?.deg).toBe(10);
    expect(model.notes.filter((note) => note.orphan).map((note) => note.title)).toEqual([
      "Ideen Ladezone",
      "Notizen Teamrunde 9. Okt.",
      "Parkplatzregelung",
      "Alte Rampenzeiten",
    ]);
    expect(new Set(model.notes.map((note) => note.id)).size).toBe(49);
    for (const note of model.notes) expect(note.id).toMatch(/^[0-9a-z]{6}$/);
    expect(model.byId.get(HANDBOOK_IDS.zl ?? "")?.updatedAt).toBe(new Date(Date.parse(FIXTURE_NOW) - 0.4 * 3_600_000).toISOString());
  });
  test("input order does not change any model ordering", () => {
    const graph = handbookGraph();
    expect(buildGraphModel({ nodes: graph.nodes.toReversed(), edges: graph.edges.toReversed() }, "en")).toEqual(model);
  });
  test("filters retain tree order and use degree across the whole graph", () => {
    expect(visibleNotes(model, { links: "all", hide: [] })).toHaveLength(49);
    expect(visibleNotes(model, { links: "linked", hide: [] })).toHaveLength(45);
    expect(visibleNotes(model, { links: "unlinked", hide: [] })).toHaveLength(4);
    const area = model.areas[1];
    if (!area) throw new Error("Missing fixture area");
    expect(visibleNotes(model, { links: "all", hide: [area.key] })).toHaveLength(41);
    expect(visibleNotes(model, { links: "all", hide: [TOP_LEVEL_AREA] })).toHaveLength(43);
    const visible = visibleNotes(model, { links: "all", hide: [TOP_LEVEL_AREA, area.key] });
    expect(visible).toHaveLength(35);
    const ids = new Set(visible.map((note) => note.id));
    const edges = visibleEdges(model, ids);
    expect(edges).toHaveLength(53);
    expect(edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
    expect(visibleEdges(model, new Set())).toEqual([]);
  });
  test("query matching trims and folds case without matching an empty query", () => {
    const note = model.notes.find((note) => note.title === "Kühlkette");
    if (!note) throw new Error("Missing fixture note");
    expect(matchesQuery(note, " KÜHL ")).toBe(true);
    expect(matchesQuery(note, " ")).toBe(false);
    expect(matchesQuery(note, "Versand")).toBe(false);
  });
  test("empty and unlinked graphs keep a neutral area", () => {
    expect(buildGraphModel({ nodes: [], edges: [] }, "en").areas).toEqual([{ key: "top", title: null, index: 0, slot: 0, count: 0 }]);
    const unlinked = buildGraphModel(unlinkedGraph(), "en");
    expect(unlinked.notes).toHaveLength(6);
    expect(unlinked.notes.every((note) => note.orphan)).toBe(true);
    expect(unlinked.areas.map((area) => area.count)).toEqual([0, 6]);
  });
  test("slots wrap after seven areas", () => {
    const nodes = Array.from({ length: 9 }, (_, index) => [
      { id: `root0${index}`, title: `Area ${index}`, parentId: null, position: index, inDegree: 0, updatedAt: FIXTURE_NOW },
      { id: `child${index}`, title: "Child", parentId: `root0${index}`, position: 0, inDegree: 0, updatedAt: FIXTURE_NOW },
    ]).flat();
    expect(buildGraphModel({ nodes, edges: [] }, "en").areas.map((area) => area.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 1, 2]);
  });
  test("missing parents and cycle members become roots; sibling ties use public ids", () => {
    const node = (id: string, parentId: string | null) => ({ id, parentId, title: id, position: 0, inDegree: 99, updatedAt: FIXTURE_NOW });
    const graph: NoteGraph = {
      nodes: [
        node("cccccc", "aaaaaa"),
        node("bbbbbb", "aaaaaa"),
        node("aaaaaa", "bbbbbb"),
        node("dddddd", "gone00"),
        node("eeeeee", "eeeeee"),
      ],
      edges: [
        { source: "aaaaaa", target: "aaaaaa" },
        { source: "aaaaaa", target: "gone00" },
        { source: "gone00", target: "aaaaaa" },
        { source: "aaaaaa", target: "cccccc" },
        { source: "aaaaaa", target: "cccccc" },
        { source: "cccccc", target: "aaaaaa" },
      ],
    };
    const result = buildGraphModel(graph, "en");
    expect(result.notes.map((note) => [note.id, note.parentId, note.depth])).toEqual([
      ["aaaaaa", null, 0],
      ["cccccc", "aaaaaa", 1],
      ["bbbbbb", null, 0],
      ["dddddd", null, 0],
      ["eeeeee", null, 0],
    ]);
    expect(result.edges).toHaveLength(2);
    expect(result.byId.get("aaaaaa")?.deg).toBe(2);
    expect(result.byId.get("aaaaaa")?.neighbours.size).toBe(1);
    expect(buildGraphModel({ nodes: graph.nodes.toReversed(), edges: graph.edges.toReversed() }, "en")).toEqual(result);
  });

  test("siblings without a hand order follow the titles, as in the sidebar and the Book", () => {
    const node = (id: string, title: string) => ({
      id,
      title,
      inDegree: 0,
      parentId: null,
      position: 0,
      updatedAt: "2026-10-16T12:00:00.000Z",
    });
    const graph = {
      nodes: [node("aaaaaa", "Zulu"), node("bbbbbb", "Chapter 10"), node("cccccc", "Chapter 2"), node("zzzzzz", "Alpha")],
      edges: [],
    };
    expect(buildGraphModel(graph, "en").notes.map((note) => note.title)).toEqual(["Alpha", "Chapter 2", "Chapter 10", "Zulu"]);
  });
});
