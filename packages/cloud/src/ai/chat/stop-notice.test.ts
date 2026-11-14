import { expect, test } from "bun:test";
import type { AssistantStopReason } from "@k2b/nessi/ai";
import { aiMessageStopNotice } from "./stop-notice";
import { truncatedAnswer } from "./stop-notice.test-fixture";

const reasons = {
  stop: false,
  tool_use: false,
  max_tokens: true,
  aborted: true,
  interrupted: true,
  error: true,
} satisfies Record<AssistantStopReason, boolean>;

test("silent truncation: every non-normal terminal finish reason surfaces on the persisted message", () => {
  for (const [stopReason, visible] of Object.entries({ ...reasons, length: true, future_terminal_reason: true }))
    expect(Boolean(aiMessageStopNotice({ ...truncatedAnswer, stopReason }))).toBe(visible);
});

test("reasoning clause uses this message's measured output, including the 80 percent boundary", () => {
  expect(aiMessageStopNotice(truncatedAnswer)).toEqual({ kind: "output_limit", reasoning: true });
  for (const [reasoning, expected] of [
    [80, true],
    [79, false],
  ] as const)
    expect(aiMessageStopNotice({ ...truncatedAnswer, usage: { input: 1, output: 100, total: 101, reasoning } })).toEqual({
      kind: "output_limit",
      reasoning: expected,
    });
  expect(aiMessageStopNotice({ ...truncatedAnswer, usage: null })).toEqual({ kind: "output_limit", reasoning: false });
});
