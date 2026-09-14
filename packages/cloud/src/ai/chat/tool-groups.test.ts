import { expect, test } from "bun:test";
import type { AiTurnBlock } from "../protocol";
import { groupToolBlocks, summarizeToolGroup } from "./tool-groups";

const tool = (id: string, name = "read_file"): Extract<AiTurnBlock, { kind: "tool" }> => ({
  id,
  callId: id,
  kind: "tool",
  name,
  status: "completed",
});

test("consecutive tools group in order while Markdown and interactive tools remain visible boundaries", () => {
  const groups = groupToolBlocks([
    tool("1"),
    tool("2"),
    { id: "m", kind: "text", text: "Checking" },
    tool("3"),
    tool("s", "code_secret"),
    tool("4"),
    tool("5"),
  ]);
  expect(groups.map((group) => (group.kind === "tools" ? group.blocks.map((block) => block.id) : group.block.id))).toEqual([
    ["1", "2"],
    "m",
    ["3"],
    "s",
    ["4", "5"],
  ]);
  expect(groupToolBlocks([tool("1"), { ...tool("2"), status: "awaiting_approval" }, tool("3")]).length).toBe(3);
});

test("summary deduplicates categories without claiming success for a failed test", () => {
  const summary = summarizeToolGroup([tool("1"), tool("2"), { ...tool("3", "code_run"), isError: true }], "en");
  expect(summary).toBe("Read files, Worked with code · 1 failed");
});

test("a completed code tool reporting a runtime error counts as failed work",()=>{
  expect(summarizeToolGroup([{id:"code",kind:"tool",name:"code_run",callId:"code",status:"completed",result:{status:"error",error:"Invalid UI"}}],"en")).toContain("1 failed");
});
