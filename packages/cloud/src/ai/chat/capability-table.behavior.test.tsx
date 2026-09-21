import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { type AiTurnBlock, buildBlocksFromMessages } from "../protocol";

type Tool = Extract<AiTurnBlock, { kind: "tool" }>;
const tableResult = (name: string) => ({
  data: { rows: [{ name }] },
  presentation: { kind: "table", rowsPath: ["rows"], columns: [{ path: ["name"], label: "Name" }] },
});
const capability: Tool = {
  id: "tool-query",
  callId: "query",
  kind: "tool",
  name: "grids__query__gql_dot_execute",
  status: "running",
  args: {},
  presentation: {
    kind: "capability",
    appId: "grids",
    appName: "Grids",
    appIcon: "ti ti-table",
    title: "Query result",
    capabilityKind: "query",
  },
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const domTest = isServer ? test.skip : test;

domTest("capability tables become visible after approval and update outside tool summaries", async () => {
  const dom = createDomTestHarness();
  const { AiTurnBlockList } = await import("./blocks");
  const [blocks, setBlocks] = createSignal<AiTurnBlock[]>([
    { ...capability, status: "awaiting_approval", approval: { message: "Allow query", allowAlways: false } },
  ]);
  const dispose = render(() => <AiTurnBlockList blocks={blocks()} turnId="turn" />, dom.root);
  try {
    expect(dom.root.querySelectorAll("table").length).toBe(0);
    setBlocks([{ ...capability, status: "completed", result: tableResult("First result") }]);
    await tick();
    expect(dom.root.querySelectorAll("table").length).toBe(1);
    expect(dom.root.querySelector("table")?.textContent).toContain("First result");
    expect(dom.root.querySelector("table")?.closest("details")).toBeNull();
    setBlocks([{ ...capability, status: "completed", result: tableResult("Updated result") }]);
    await tick();
    expect(dom.root.querySelectorAll("table").length).toBe(1);
    expect(dom.root.querySelector("table")?.textContent).toContain("Updated result");
  } finally {
    dispose();
    dom.cleanup();
  }
});

domTest("persisted table results render without optional capability branding", async () => {
  const dom = createDomTestHarness();
  const { AiTurnBlockList } = await import("./blocks");
  const blocks = buildBlocksFromMessages([
    { seq: 1, message: { role: "assistant", content: [{ type: "tool_call", id: "query", name: capability.name, args: {} }] } },
    {
      seq: 2,
      message: { role: "tool_result", callId: "query", name: capability.name, result: tableResult("Saved result"), isError: false },
    },
  ]);
  const dispose = render(() => <AiTurnBlockList blocks={blocks} turnId="turn" />, dom.root);
  try {
    expect(dom.root.querySelectorAll("table").length).toBe(1);
    expect(dom.root.querySelector("table")?.textContent).toContain("Saved result");
    expect(dom.root.querySelector("table")?.closest("details")).toBeNull();
  } finally {
    dispose();
    dom.cleanup();
  }
});
