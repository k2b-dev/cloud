import { describe, expect, test } from "bun:test";
import { adjacency, componentIndex, cycleComponents, cycleWitness, relationLevels } from "./group-graph";

const graph = (pairs: [string, string][]) => adjacency(pairs, (left, right) => left.localeCompare(right));

describe("group graph", () => {
  test("finds cycles, including a group that contains itself, and nothing else", () => {
    const g = graph([
      ["all", "tech"],
      ["tech", "platform"],
      ["platform", "oncall"],
      ["oncall", "tech"],
      ["all", "sales"],
      ["self", "self"],
    ]);
    const cycles = cycleComponents([...g.nodes].sort(), g.down);
    expect(cycles.map((component) => [...component].sort())).toEqual([["oncall", "platform", "tech"], ["self"]]);
  });

  test("shows a real cycle through the group, not just its component", () => {
    const g = graph([
      ["a", "b"],
      ["b", "c"],
      ["c", "a"],
      ["b", "d"],
      ["d", "b"],
    ]);
    const of = componentIndex(cycleComponents([...g.nodes].sort(), g.down));
    expect(cycleWitness("d", g.down, of)).toEqual(["d", "b", "d"]);
    expect(cycleWitness("a", g.down, of)).toEqual(["a", "b", "c", "a"]);
    expect(cycleWitness("x", g.down, of)).toEqual([]);
  });

  test("levels show each group once and turn edges to groups already shown into back edges", () => {
    const g = graph([
      ["all", "tech"],
      ["tech", "platform"],
      ["platform", "oncall"],
      ["oncall", "tech"],
    ]);
    const seen = new Set(["tech"]);
    const down = relationLevels("tech", 4, g.down, seen);
    const up = relationLevels("tech", 4, g.up, seen);
    expect(down).toEqual([
      { items: [{ id: "platform", via: "tech" }], backs: [] },
      { items: [{ id: "oncall", via: "platform" }], backs: [] },
      { items: [], backs: [{ from: "oncall", to: "tech" }] },
    ]);
    expect(up).toEqual([{ items: [{ id: "all", via: "tech" }], backs: [{ from: "tech", to: "oncall" }] }]);
  });

  test("a chain far deeper than the call stack and a dense cycle stay iterative", () => {
    const chain: [string, string][] = Array.from({ length: 200_000 }, (_, index) => [`g${index}`, `g${index + 1}`]);
    chain.push(["g200000", "g0"]);
    const g = graph(chain);
    const cycles = cycleComponents(g.nodes, g.down);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(200_001);
    expect(relationLevels("g0", 4, g.down, new Set(["g0"])).map((level) => level.items.length)).toEqual([1, 1, 1, 1]);
  });
});
