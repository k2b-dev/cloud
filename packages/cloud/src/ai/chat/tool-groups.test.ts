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

const rows = (blocks: AiTurnBlock[], direct?: ReadonlySet<string>) =>
  groupWorkBlocks(blocks, direct).items.map((item) =>
    item.kind === "housekeeping" ? item.entries.map((entry) => entry.id) : item.kind === "text" ? `text ${item.block.id}` : item.entry.id,
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
  expect(work.items.map((item) => (item.kind === "housekeeping" ? [item.id, item.entries.map((entry) => entry.id)] : item.kind))).toEqual([
    "step",
    ["skill", ["skill", "r1", "ref", "tools"]],
    "step",
    "step",
    "step",
  ]);
  expect(work.unfolded).toEqual([]);
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
  expect(groupWorkBlocks(loading).unfolded).toEqual(["a"]);
  expect(rows([...loading, tool("e", "code_run")])).toEqual(["a", "b", "c", "d", "e"]);
  const more = [...loading, tool("e", "code_run"), tool("f", "code_run")];
  expect(rows(more)).toEqual([["a", "b", "c", "d"], "e", "f"]);
  expect(rows(more, new Set(["a"]))).toEqual(["a", "b", "c", "d", "e", "f"]);
  // A single housekeeping step is not worth a group.
  expect(rows([tool("a", "load_skill"), tool("e", "code_run"), tool("f", "code_run")])).toEqual(["a", "e", "f"]);
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
