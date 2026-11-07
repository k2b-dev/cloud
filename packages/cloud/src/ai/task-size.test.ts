import { expect, test } from "bun:test";
import { AI_TASK_REQUEST_MAX_BYTES, assertAiTaskRequestSize } from "./task-contracts";

test("the task budget includes the envelope, escaping and UTF-8 bytes", () => {
  const envelope = { kind: "classify", prompt: "Choose", input: "", choices: ["a", "b"] };
  const remaining = AI_TASK_REQUEST_MAX_BYTES - Buffer.byteLength(JSON.stringify(envelope));
  expect(() => assertAiTaskRequestSize({ ...envelope, input: "x".repeat(remaining) })).not.toThrow();
  expect(() => assertAiTaskRequestSize({ ...envelope, input: "x".repeat(remaining + 1) })).toThrow();
  expect(() => assertAiTaskRequestSize({ ...envelope, input: "😀".repeat(25_000) })).toThrow();
  expect(() => assertAiTaskRequestSize({ ...envelope, input: "\n".repeat(50_000) })).toThrow();
});
