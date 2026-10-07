import { expect, test } from "bun:test";
import type { AiTurnBlock } from "../protocol";
import { countWorkSteps, groupWorkBlocks, isFailedTool, summarizeToolGroup } from "./tool-groups";

const tool = (id: string, name = "read_file"): Extract<AiTurnBlock, { kind: "tool" }> => ({
  id,
  callId: id,
  kind: "tool",
  name,
  status: "completed",
});

test("intermediate texts separate step groups and reasoning stays inside its group", () => {
  const groups = groupWorkBlocks([
    { id: "r0", kind: "thinking", text: "First" },
    tool("1"),
    { id: "r1", kind: "thinking", text: "Then" },
    tool("2"),
    { id: "m", kind: "text", text: "Checking" },
    tool("3"),
    { id: "c", kind: "compaction", status: "completed" },
  ]);
  expect(groups.map((group) => (group.kind === "steps" ? group.entries.map((entry) => entry.id) : group.block.id))).toEqual([
    ["r0", "1", "r1", "2"],
    "m",
    ["3", "c"],
  ]);
  // Groups are keyed by their first tool: reasoning ids differ between a live turn and its history.
  expect(groups.flatMap((group) => (group.kind === "steps" ? [group.id] : []))).toEqual(["1", "3"]);
});

test("summary deduplicates categories; failures and rejections are counted apart", () => {
  const tools = [
    tool("1"),
    tool("2"),
    { ...tool("3", "code_run"), isError: true },
    { ...tool("4", "local_bash"), status: "rejected" as const },
  ];
  expect(summarizeToolGroup(tools, "en")).toBe("Read files, Worked with code, Used tools");
  expect(countWorkSteps(tools, "en")).toBe("4 steps · 1 failed · 1 rejected");
  expect(countWorkSteps(tools, "de")).toBe("4 Schritte · 1 fehlgeschlagen · 1 abgelehnt");
  expect(isFailedTool(tools[3]!)).toBe(false);
});

test("PDF conversions and delivered results have their own localized summary", () => {
  const tools = [tool("write", "write_file"), tool("markdown", "markdown_to_pdf"), tool("html", "html_to_pdf"), tool("p", "present")];
  expect(summarizeToolGroup(tools, "en")).toBe("Wrote files, Created PDFs, Delivered results");
  expect(summarizeToolGroup(tools, "de")).toBe("Dateien geschrieben, PDFs erstellt, Ergebnisse bereitgestellt");
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
