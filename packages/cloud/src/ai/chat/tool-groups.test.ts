import { expect, test } from "bun:test";
import type { AiTurnBlock } from "../protocol";
import { countWorkSteps, groupWorkBlocks, isFailedTool } from "./tool-groups";

const tool = (id: string, name = "read_file"): Extract<AiTurnBlock, { kind: "tool" }> => ({
  id,
  callId: id,
  kind: "tool",
  name,
  status: "completed",
});

const rows = (blocks: AiTurnBlock[], shown?: ReadonlySet<string>) =>
  groupWorkBlocks(blocks, shown).map((item) =>
    item.kind === "housekeeping" || item.kind === "repeat"
      ? item.entries.map((entry) => entry.id)
      : item.kind === "text"
        ? `text ${item.block.id}`
        : item.entry.id,
  );

test("steps show directly at one level; intermediate texts stay in order", () => {
  expect(
    rows([
      { id: "r0", kind: "thinking", text: "First" },
      tool("1"),
      tool("2", "code_run"),
      { id: "m", kind: "text", text: "Checking" },
      tool("3", "write_file"),
      { id: "c", kind: "compaction", status: "completed" },
    ]),
  ).toEqual(["r0", "1", "2", "text m", "3", "c"]);
});

test("housekeeping folds into one group with the reasoning between its steps, keyed by its first tool", () => {
  const work = groupWorkBlocks([
    { id: "r0", kind: "thinking", text: "Which skill?" },
    tool("skill", "load_skill"),
    { id: "r1", kind: "thinking", text: "Read its reference" },
    { ...tool("ref"), args: { path: "/skills/report/reference.md" } },
    tool("tools", "load_tools"),
    { id: "r2", kind: "thinking", text: "Now the data" },
    tool("data", "read_file"),
    tool("run", "code_run"),
  ]);
  expect(work.map((item) => (item.kind === "housekeeping" ? [item.id, item.entries.map((entry) => entry.id)] : item.kind))).toEqual([
    "step",
    ["skill", ["skill", "r1", "ref", "tools"]],
    "step",
    "step",
    "step",
  ]);
  // A project file is work, not housekeeping.
  expect(rows([tool("a", "load_skill"), tool("b", "load_tools"), { ...tool("c"), args: { path: "/project/a.csv" } }, tool("d")])).toEqual([
    ["a", "b"],
    "c",
    "d",
  ]);
});

test("a group that would hold all but one step shows its steps directly, and steps a reader saw stay unfolded", () => {
  const loading = [tool("a", "load_skill"), tool("b", "search_tools"), tool("c", "load_tools"), tool("d", "read_help")];
  expect(rows(loading)).toEqual(["a", "b", "c", "d"]);
  expect(rows([...loading, tool("e", "code_run")])).toEqual(["a", "b", "c", "d", "e"]);
  const more = [...loading, tool("e", "code_run"), tool("f", "code_run")];
  expect(rows(more)).toEqual([["a", "b", "c", "d"], "e", "f"]);
  expect(rows(more, new Set(["a", "b", "c", "d"]))).toEqual(["a", "b", "c", "d", "e", "f"]);
  // A single housekeeping step is not worth a group.
  expect(rows([tool("a", "load_skill"), tool("e", "code_run"), tool("f", "code_run")])).toEqual(["a", "e", "f"]);
});

test("a row already shown never joins a group, also when reasoning or arguments that would fold it arrive later", () => {
  const work = [tool("x", "code_run"), tool("y", "code_run"), tool("a", "load_skill"), tool("b", "load_tools")];
  const thought: AiTurnBlock = { id: "t", kind: "thinking", text: "Which reference?" };
  expect(rows([...work, thought])).toEqual(["x", "y", ["a", "b"], "t"]);
  // Housekeeping after the reasoning would pull it into the group; once shown, it stays and the group ends before it.
  const next = [...work, thought, tool("c", "load_skill")];
  expect(rows(next)).toEqual(["x", "y", ["a", "b", "t", "c"]]);
  expect(rows(next, new Set(["x", "y", "t"]))).toEqual(["x", "y", ["a", "b"], "t", "c"]);
  // A file read shown before its arguments arrived stays, though its path turns out to be a loaded skill's file.
  const skillFile = { ...tool("r"), args: { path: "/skills/report/SKILL.md" } };
  expect(rows([...work, skillFile])).toEqual(["x", "y", ["a", "b", "r"]]);
  expect(rows([...work, skillFile], new Set(["x", "y", "r"]))).toEqual(["x", "y", ["a", "b"], "r"]);
});

test("failures and rejections are counted apart", () => {
  const tools = [
    tool("1"),
    tool("2"),
    { ...tool("3", "code_run"), isError: true },
    { ...tool("4", "local_bash"), status: "rejected" as const },
  ];
  expect(countWorkSteps(tools, "en")).toBe("4 steps · 1 failed · 1 rejected");
  expect(countWorkSteps(tools, "de")).toBe("4 Schritte · 1 fehlgeschlagen · 1 abgelehnt");
  expect(isFailedTool(tools[3]!)).toBe(false);
});

test("a completed code tool reporting a runtime error counts as failed work", () => {
  expect(
    countWorkSteps(
      [
        {
          id: "code",
          kind: "tool",
          name: "code_run",
          callId: "code",
          status: "completed",
          result: { status: "error", error: "Invalid UI" },
        },
      ],
      "en",
    ),
  ).toBe("1 step · 1 failed");
});

const read = (id: string, offset = 0) => ({ ...tool(id), args: { path: "/products-100.csv", offset, length: 100 } });
const otherSteps = [tool("run", "code_run"), tool("check", "code_check")];

test("repeated reads fold by trimmed target with intervening reasoning and the first tool's id", () => {
  const thought: AiTurnBlock = { id: "between", kind: "thinking", text: "Next chunk" };
  const after: AiTurnBlock = { id: "after", kind: "thinking", text: "Now check" };
  const blocks = [
    read("a"),
    thought,
    { ...read("b", 100), args: { path: " /products-100.csv ", offset: 100 } },
    read("c", 200),
    after,
    ...otherSteps,
  ];
  expect(groupWorkBlocks(blocks)[0]).toEqual({
    kind: "repeat",
    id: "a",
    target: "/products-100.csv",
    entries: blocks.slice(0, 4),
  });
  expect(rows(blocks)).toEqual([["a", "between", "b", "c"], "after", "run", "check"]);
});

test("failed, rejected and waiting calls break repeats and stay visible", () => {
  const decisions: Extract<AiTurnBlock, { kind: "tool" }>[] = [
    { ...read("middle"), isError: true },
    { ...read("middle"), status: "failed" },
    { ...read("middle"), status: "rejected" },
    { ...read("middle"), status: "awaiting_approval" },
    { ...read("middle"), status: "awaiting_client" },
  ];
  for (const decision of decisions) {
    expect(rows([read("a"), read("b"), decision, read("c"), read("d"), ...otherSteps])).toEqual([
      ["a", "b"],
      "middle",
      ["c", "d"],
      "run",
      "check",
    ]);
  }
  expect(
    rows([
      { ...tool("a", "code_run"), args: { path: "/script" } },
      { ...tool("bad", "code_run"), args: { path: "/script" }, result: { status: "error" } },
      { ...tool("b", "code_run"), args: { path: "/script" } },
      ...otherSteps,
    ]),
  ).toEqual(["a", "bad", "b", "run", "check"]);
});

test("intermediate text, compaction and steering break repeat runs", () => {
  const breaks: AiTurnBlock[] = [
    { id: "middle", kind: "text", text: "Checking" },
    { id: "middle", kind: "compaction", status: "completed" },
    { id: "middle", kind: "steer_applied", steerId: "steer" },
  ];
  for (const entry of breaks) {
    expect(rows([read("a"), entry, read("b"), ...otherSteps])).toEqual([
      "a",
      entry.kind === "text" ? "text middle" : "middle",
      "b",
      "run",
      "check",
    ]);
  }
});

test("different paths or tool names do not fold", () => {
  expect(rows([read("a"), { ...read("b"), args: { path: "/other.csv" } }, ...otherSteps])).toEqual(["a", "b", "run", "check"]);
  expect(rows([read("a"), { ...read("b"), name: "write_file" }, ...otherSteps])).toEqual(["a", "b", "run", "check"]);
});

test("different scope ids, filters and append content do not fold on the same target", () => {
  for (const [name, first, second] of [
    ["contacts__list", { bookId: "B1", query: "Mueller" }, { bookId: "B2", query: "Mueller" }],
    ["fs__browse", { baseId: "A", path: "/Docs" }, { baseId: "B", path: "/Docs" }],
    ["fs__browse", { path: "/Docs", query: "first" }, { path: "/Docs", query: "second" }],
    ["write_file", { path: "/r.md", content: "1", mode: "append" }, { path: "/r.md", content: "2", mode: "append" }],
  ] as const) {
    expect(rows([{ ...tool("a", name), args: first }, { ...tool("b", name), args: second }, ...otherSteps])).toEqual([
      "a",
      "b",
      "run",
      "check",
    ]);
  }
});

test("only top-level paging arguments may differ or be omitted in a repeat", () => {
  for (const key of ["offset", "length", "limit", "cursor", "after", "page", "pageSize"]) {
    expect(
      rows([
        { ...tool("a"), args: { path: "/Docs", [key]: 1 } },
        { ...tool("b"), args: { path: "/Docs", [key]: 2 } },
        { ...tool("c"), args: { path: "/Docs" } },
        ...otherSteps,
      ]),
    ).toEqual([["a", "b", "c"], "run", "check"]);
    expect(
      rows([
        { ...tool("a"), args: { path: "/Docs", filter: { [key]: 1 } } },
        { ...tool("b"), args: { path: "/Docs", filter: { [key]: 2 } } },
        ...otherSteps,
      ]),
    ).toEqual(["a", "b", "run", "check"]);
  }
});

test("argument key order and surrounding whitespace do not prevent repeats", () => {
  expect(
    rows([
      { ...tool("a", "fs__browse"), args: { baseId: "A", path: "/Docs", after: "x" } },
      { ...tool("b", "fs__browse"), args: { path: " /Docs ", baseId: " A " } },
      ...otherSteps,
    ]),
  ).toEqual([["a", "b"], "run", "check"]);
});

test("nested objects and arrays compare by value with trimmed strings", () => {
  const first = { path: "/Docs", filter: { tags: ["a", { name: "b", enabled: true }], count: 2 } };
  const equal = { filter: { count: 2, tags: [" a ", { enabled: true, name: " b " }] }, path: "/Docs" };
  expect(rows([{ ...tool("a"), args: first }, { ...tool("b"), args: equal }, ...otherSteps])).toEqual([["a", "b"], "run", "check"]);
  for (const filter of [
    { tags: ["a", { name: "b", enabled: false }], count: 2 },
    { tags: [{ name: "b", enabled: true }, "a"], count: 2 },
  ]) {
    expect(rows([{ ...tool("a"), args: first }, { ...tool("b"), args: { path: "/Docs", filter } }, ...otherSteps])).toEqual([
      "a",
      "b",
      "run",
      "check",
    ]);
  }
});

test("repeat folds leave at least two other steps", () => {
  const reads = [read("a"), read("b"), read("c")];
  expect(rows(reads)).toEqual(["a", "b", "c"]);
  expect(rows([...reads, otherSteps[0]!])).toEqual(["a", "b", "c", "run"]);
  expect(rows([...reads, ...otherSteps])).toEqual([["a", "b", "c"], "run", "check"]);
});

test("watched reads and reasoning never join a repeat", () => {
  const reads = [read("a"), read("b"), read("c"), ...otherSteps];
  expect(rows(reads, new Set(["b"]))).toEqual(["a", "b", "c", "run", "check"]);
  const thought: AiTurnBlock = { id: "t", kind: "thinking", text: "Next" };
  expect(rows([read("a"), thought, read("b"), ...otherSteps], new Set(["t"]))).toEqual(["a", "t", "b", "run", "check"]);
});

test("URL and query targets fold; path then URL then query take precedence", () => {
  for (const [name, args, target] of [
    ["web_fetch", { url: " https://example.com " }, "https://example.com"],
    ["web_search", { query: " products " }, "products"],
    ["web_fetch", { path: " ", url: " https://example.com ", query: "other" }, "https://example.com"],
    ["web_search", { path: 42, url: "", query: " products " }, "products"],
    ["read_file", { path: "/products-100.csv", url: "other", query: "other" }, "/products-100.csv"],
  ] as const) {
    const calls = [
      { ...tool("a", name), args },
      { ...tool("b", name), args },
    ];
    expect(groupWorkBlocks([...calls, ...otherSteps])[0]).toEqual({ kind: "repeat", id: "a", target, entries: calls });
  }
  for (const args of [undefined, null, [], { path: " ", url: "", query: 42 }]) {
    expect(rows([{ ...tool("a"), args }, { ...tool("b"), args }, ...otherSteps])).toEqual(["a", "b", "run", "check"]);
  }
  expect(
    groupWorkBlocks([
      { ...tool("a", "search_help"), args: { query: "products" } },
      { ...tool("b", "search_help"), args: { query: "products" } },
      ...otherSteps,
    ])[0]?.kind,
  ).toBe("housekeeping");
  expect(
    groupWorkBlocks([
      { ...read("a"), args: { path: "/skills/report/SKILL.md" } },
      { ...read("b"), args: { path: "/skills/report/SKILL.md" } },
      ...otherSteps,
    ])[0]?.kind,
  ).toBe("housekeeping");
});

test("running and completed repeat runs have the same kinds and keys", () => {
  const history = [read("a"), read("b"), read("c"), ...otherSteps];
  const live = [read("a"), read("b"), { ...read("c"), status: "running" as const }, ...otherSteps];
  const keys = (blocks: AiTurnBlock[]) =>
    groupWorkBlocks(blocks).map((item) =>
      item.kind === "text" ? [item.kind, item.block.id] : item.kind === "step" ? [item.kind, item.entry.id] : [item.kind, item.id],
    );
  expect(keys(live)).toEqual(keys(history));
  expect(keys(live)).toEqual([
    ["repeat", "a"],
    ["step", "run"],
    ["step", "check"],
  ]);
});
