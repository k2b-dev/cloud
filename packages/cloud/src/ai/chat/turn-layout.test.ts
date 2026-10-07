import { describe, expect, test } from "bun:test";
import type { AiTurnBlock } from "../protocol";
import { hasCompleteSentence, layoutAiTurn } from "./turn-layout";

type Tool = Extract<AiTurnBlock, { kind: "tool" }>;

const text = (id: string, value: string): AiTurnBlock => ({ id, kind: "text", text: value });
const thinking = (id: string): AiTurnBlock => ({ id, kind: "thinking", text: "Considering the files." });
const tool = (id: string, name: string, patch: Partial<Tool> = {}): Tool => ({
  id: `tool-${id}`,
  kind: "tool",
  callId: id,
  name,
  status: "completed",
  result: {},
  ...patch,
});
const capability = (id: string, kind: "query" | "action", patch: Partial<Tool> = {}): Tool =>
  tool(id, `mail__${kind}__send`, {
    presentation: { kind: "capability", appId: "mail", appName: "Mail", appIcon: "ti ti-mail", title: "Send email", capabilityKind: kind },
    ...patch,
  });
const ids = (blocks: readonly { id: string }[]) => blocks.map((block) => block.id);

describe("turn layout", () => {
  test("folds intermediate text, reasoning and ordinary tools; keeps results, the final text and receipts", () => {
    const blocks: AiTurnBlock[] = [
      text("t1", "I read the files first."),
      thinking("r1"),
      tool("read", "read_file", { args: { path: "/orders.csv" } }),
      tool("csv", "present", { args: { path: "/joined.csv" } }),
      tool("image", "view_image", { args: { path: "/chart.png" } }),
      tool("view", "code_present", { args: { runId: "run", title: "Dashboard" } }),
      capability("mail", "action", { result: { summary: "Email sent to Jana Berger" } }),
      capability("lookup", "query"),
      text("t2", "Revenue grew by 8 %."),
    ];
    const layout = layoutAiTurn(blocks, { phase: "completed", codePresentations: true });

    expect(layout.showWork).toBe(true);
    expect(layout.steps).toBe(6);
    expect(ids(layout.text)).toEqual(["t2"]);
    expect(ids(layout.results)).toEqual(["tool-csv", "tool-view"]);
    expect(layout.actions.map((action) => [action.id, action.state])).toEqual([["tool-mail", "done"]]);
    // Every step stays reachable in the expanded work list, results and receipts included.
    expect(ids(layout.work)).toEqual(ids(blocks.filter((block) => block.id !== "t2")));
  });

  test("live and history produce the same places for the same blocks", () => {
    const blocks: AiTurnBlock[] = [
      text("t1", "Checking."),
      tool("read", "read_file"),
      tool("pdf", "present", { args: { path: "/report.pdf" } }),
      text("t2", "Done."),
    ];
    const live = layoutAiTurn(blocks, { phase: "running" });
    const stored = layoutAiTurn(blocks, { phase: "completed" });
    expect(ids(live.results)).toEqual(ids(stored.results));
    expect(ids(live.text)).toEqual(ids(stored.text));
    expect(ids(live.work)).toEqual(ids(stored.work));
  });

  test("a new status replaces the previous one only after its first sentence", () => {
    const blocks = (newest: string): AiTurnBlock[] => [text("t1", "The data is clean."), tool("run", "code_run"), text("t2", newest)];
    expect(ids(layoutAiTurn(blocks("Now I build"), { phase: "running" }).text)).toEqual(["t1"]);
    expect(ids(layoutAiTurn(blocks("Now I build the dashboard."), { phase: "running" }).text)).toEqual(["t2"]);
    // History always shows the last text.
    expect(ids(layoutAiTurn(blocks("Now I build"), { phase: "completed" }).text)).toEqual(["t2"]);
    expect(hasCompleteSentence("Version 3.5 is")).toBe(false);
    expect(hasCompleteSentence("Line one\nline two")).toBe(true);
  });

  test("the last text before a late tool call stays the final message", () => {
    const layout = layoutAiTurn([tool("read", "read_file"), text("t1", "Here is the summary."), tool("memory", "memory")], {
      phase: "completed",
    });
    expect(ids(layout.text)).toEqual(["t1"]);
  });

  test("text, steering and reasoning without tools get no work line", () => {
    const layout = layoutAiTurn([thinking("r1"), text("t1", "Tokyo: 02:14."), thinking("r2"), text("t2", "It is night.")], {
      phase: "completed",
    });
    expect(layout.showWork).toBe(false);
    expect(ids(layout.text)).toEqual(["t1", "t2"]);
    expect(layoutAiTurn([{ id: "s", kind: "steer_applied", steerId: "s" }], { phase: "completed" }).showWork).toBe(false);
  });

  test("a stopped or failed turn folds all of its text into the work line", () => {
    for (const phase of ["stopped", "failed"] as const) {
      const layout = layoutAiTurn([text("t1", "Now I build the dashboard."), tool("run", "code_run")], { phase });
      expect(layout.text).toEqual([]);
      expect(layout.showWork).toBe(true);
      expect(ids(layout.work)).toEqual(["t1", "tool-run"]);
    }
    expect(layoutAiTurn([text("t1", "Starting.")], { phase: "stopped" }).showWork).toBe(true);
  });

  test("a result with the same target replaces the earlier one at its place", () => {
    const layout = layoutAiTurn(
      [
        tool("v1", "code_present", { args: { title: "Dashboard" } }),
        tool("csv", "present", { args: { path: "/data.csv" } }),
        tool("v2", "code_present", { args: { title: "dashboard " } }),
        tool("csv2", "present", { args: { path: "/data.csv" } }),
      ],
      { phase: "completed", codePresentations: true },
    );
    expect(layout.results.map((result) => [result.id, result.block.callId])).toEqual([
      ["tool-v1", "v2"],
      ["tool-csv", "csv2"],
    ]);
  });

  test("failed results, hostless visualizations, and undelivered history count as work", () => {
    const layout = layoutAiTurn(
      [
        tool("bad", "present", { status: "failed", isError: true }),
        tool("view", "code_present", { args: { title: "View" } }),
        tool("late", "present", { status: "running", result: undefined }),
      ],
      { phase: "completed" },
    );
    expect(layout.results).toEqual([]);
    // While the turn runs, a running delivery reserves its place.
    expect(ids(layoutAiTurn([tool("late", "present", { status: "running" })], { phase: "running" }).results)).toEqual(["tool-late"]);
  });

  test("approvals stay at their place: open card, then receipt, or not run after a stop", () => {
    const pending = capability("mail", "action", { status: "awaiting_approval", result: undefined, approval: { allowAlways: false } });
    const waiting = layoutAiTurn([tool("read", "read_file"), pending], { phase: "waiting" });
    expect(waiting.actions.map((action) => action.state)).toEqual(["open"]);
    expect(waiting.waitingFor).toBe("approval");

    const states = (patch: Partial<Tool>, phase: "running" | "completed" | "stopped") =>
      layoutAiTurn([capability("mail", "action", patch)], { phase }).actions.map((action) => [action.id, action.state]);
    expect(states({ status: "running", result: undefined }, "running")).toEqual([["tool-mail", "running"]]);
    expect(states({ status: "rejected" }, "completed")).toEqual([["tool-mail", "rejected"]]);
    expect(states({ status: "failed", isError: true }, "completed")).toEqual([["tool-mail", "failed"]]);
    expect(states({ status: "running", result: undefined }, "stopped")).toEqual([["tool-mail", "not_run"]]);
  });

  test("an approved ordinary tool keeps the card's place as a receipt", () => {
    const pending = tool("run", "code_run", { status: "awaiting_approval", result: undefined, approval: { allowAlways: false } });
    expect(layoutAiTurn([pending], { phase: "waiting" }).actions.map((action) => action.state)).toEqual(["open"]);
    const states = (patch: Partial<Tool>, phase: "running" | "completed" | "stopped") =>
      layoutAiTurn([tool("run", "code_run", { approved: true, ...patch })], { phase }).actions.map((action) => [action.id, action.state]);
    expect(states({ status: "running", result: undefined }, "running")).toEqual([["tool-run", "running"]]);
    expect(states({}, "completed")).toEqual([["tool-run", "done"]]);
    expect(states({ status: "running", result: undefined }, "stopped")).toEqual([["tool-run", "not_run"]]);
    // Without a decision, the same call is an ordinary step.
    expect(layoutAiTurn([tool("run", "code_run")], { phase: "completed" }).actions).toEqual([]);
  });

  test("a rejected ordinary tool is a decision receipt, not a failure", () => {
    const layout = layoutAiTurn([tool("bash", "local_bash", { status: "rejected" })], { phase: "completed" });
    expect(layout.actions.map((action) => action.state)).toEqual(["rejected"]);
  });

  test("open interactions and the waiting reason", () => {
    const survey = tool("survey", "survey", { status: "awaiting_client", result: undefined });
    const layout = layoutAiTurn([survey], { phase: "waiting" });
    expect(layout.actions.map((action) => action.state)).toEqual(["interaction"]);
    expect(layout.waitingFor).toBe("answer");
    const secret = layoutAiTurn([tool("secret", "code_secret", { status: "awaiting_client" })], { phase: "waiting" });
    expect(secret.actions.map((action) => action.state)).toEqual(["interaction"]);
    expect(layoutAiTurn([tool("secret", "code_secret")], { phase: "completed" }).actions).toEqual([]);
  });

  test("the current step is the newest block", () => {
    const layout = layoutAiTurn([text("t1", "Reading."), tool("read", "read_file", { status: "running" })], { phase: "running" });
    expect(layout.current?.id).toBe("tool-read");
  });
});
