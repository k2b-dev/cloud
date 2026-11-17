import { expect, test } from "bun:test";
import type { AiTurnBlock } from "../protocol";
import { workApps, workSummary } from "./work-summary";

const call = (id: string, name: string): AiTurnBlock => ({
  id: `tool-${id}`,
  kind: "tool",
  callId: id,
  name,
  args: {},
  status: "completed",
  result: {},
});

/**
 * A follow-up turn of the Preview tour (15.11., chat "Bau mir eine Automation", "Gustav überarbeitet"): Gustav reworks
 * the automation in six Code steps and nothing else.
 */
const rework: AiTurnBlock[] = [
  call("1", "code_pull"),
  call("2", "code_write"),
  call("3", "code_check"),
  call("4", "code_test"),
  call("5", "code_test"),
  call("6", "code_submit"),
];

test("a follow-up turn that only builds code says what it did, with Code's tile", () => {
  expect(workSummary(rework, "de")).toBe("Geschrieben, geprüft, ausprobiert und eingereicht");
  expect(workSummary(rework, "en")).toBe("Written, checked, tried out, and submitted");
  expect(workApps(rework)).toEqual([{ key: "code", name: "Code", icon: "ti ti-code" }]);
});

test("beside other work, the code is named", () => {
  const mixed: AiTurnBlock[] = [{ ...call("w", "web_search") }, call("2", "code_write"), call("6", "code_submit")];
  expect(workSummary(mixed, "de")).toBe("Im Web gesucht, Code geschrieben und eingereicht");
  expect(workApps(mixed).map((app) => app.key)).toEqual(["web", "code"]);
});

test("an outcome Cloud could not see counts as unclear in warning, until a check settles it", async () => {
  const { workStepParts } = await import("./work-summary");
  const failed = (id: string, name: string, result: string): Extract<AiTurnBlock, { kind: "tool" }> => ({
    id: `tool-${id}`,
    kind: "tool",
    callId: id,
    name,
    args: {},
    status: "failed",
    isError: true,
    result,
  });
  const unclear = (check?: "done" | "not_done"): AiTurnBlock => ({
    ...failed("send", "mail__action__send", "ACTION_OUTCOME_UNKNOWN: The Action response was lost."),
    ...(check ? { check: { state: check, at: "2026-11-15T10:00:00.000Z" } } : {}),
  });
  const denied = failed("read", "files__query__read", "FORBIDDEN: no");
  expect(workStepParts([unclear(), denied], 2, "de").issues).toEqual([
    { text: "1 unklar", tone: "warning" },
    { text: "1 ohne Zugriff", tone: "warning" },
  ]);
  expect(workStepParts([unclear("done")], 1, "de").issues).toEqual([]);
  expect(workStepParts([unclear("not_done")], 1, "en").issues).toEqual([{ text: "1 failed", tone: "danger" }]);
});
