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
    const down = relationLevels("tech", 4, g.down, seen, { budget: () => 10 });
    const up = relationLevels("tech", 4, g.up, seen, { budget: () => 10 });
    expect(down).toEqual([
      { items: [{ id: "platform", via: "tech" }], backs: [], hidden: 0 },
      { items: [{ id: "oncall", via: "platform" }], backs: [], hidden: 0 },
      { items: [], backs: [{ from: "oncall", to: "tech" }], hidden: 0 },
    ]);
    expect(up).toEqual([{ items: [{ id: "all", via: "tech" }], backs: [{ from: "tech", to: "oncall" }], hidden: 0 }]);
  });

  test("a budget hides groups, and the next level grows only from the groups shown", () => {
    const pairs: [string, string][] = [];
    for (const child of ["a", "b", "c", "d"]) pairs.push(["top", child], [child, `${child}-1`]);
    const g = graph(pairs);
    const levels = relationLevels("top", 2, g.down, new Set(["top"]), { budget: (level) => (level === 1 ? 2 : 10) });
    expect(levels).toEqual([
      {
        items: [
          { id: "a", via: "top" },
          { id: "b", via: "top" },
        ],
        backs: [],
        hidden: 2,
      },
      {
        items: [
          { id: "a-1", via: "a" },
          { id: "b-1", via: "b" },
        ],
        backs: [],
        hidden: 0,
      },
    ]);
  });

  test("a chain far deeper than the call stack and a dense cycle stay iterative", () => {
    const chain: [string, string][] = Array.from({ length: 200_000 }, (_, index) => [`g${index}`, `g${index + 1}`]);
    chain.push(["g200000", "g0"]);
    const g = graph(chain);
    const cycles = cycleComponents(g.nodes, g.down);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(200_001);
    const levels = relationLevels("g0", 4, g.down, new Set(["g0"]), { budget: () => 10 });
    expect(levels.map((level) => level.items.length)).toEqual([1, 1, 1, 1]);
  });
});
