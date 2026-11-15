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
