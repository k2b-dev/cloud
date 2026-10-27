import { expect, test } from "bun:test";
import type { z } from "zod";
import type { RunAiStructuredInput, RunAiStructuredResult } from "./structured";
import { AiTaskRequestSchema } from "./task-contracts";
import { executeAiTask } from "./task-execution";

const request = AiTaskRequestSchema.parse({
  kind: "extract_data",
  prompt: "Summarize",
  input: "Source",
  fields: [
    { name: "summary", type: "text", description: "Nonblank summary", minLength: 1, maxLength: 1000 },
    { name: "due", type: "date_time", description: "Explicit deadline", required: false },
  ],
});

test("blank text and invalid optional dates fail the provider-facing schema before durable success", async () => {
  for (const output of [{ summary: " " }, { summary: "Meeting", due: "2026-10-28" }]) {
    const runner = async <T extends z.ZodType>(input: RunAiStructuredInput<T>): Promise<RunAiStructuredResult<T>> => ({
      output: input.output.parse(output),
      modelProfileId: "fake",
      structuredMeta: { mode: "native", repaired: false, attempts: 1, usedResponseFormat: true },
    });
    await expect(executeAiTask(request, { taskPrefix: "application" }, runner)).rejects.toThrow();
  }
  const runner = async <T extends z.ZodType>(input: RunAiStructuredInput<T>): Promise<RunAiStructuredResult<T>> => ({
    output: input.output.parse({ summary: "  Meeting agreed  " }),
    modelProfileId: "fake",
    structuredMeta: { mode: "native", repaired: false, attempts: 1, usedResponseFormat: true },
  });
  expect((await executeAiTask(request, { taskPrefix: "application" }, runner)).output).toEqual({ summary: "Meeting agreed" });
});

test("minimum trimmed length only applies to text and stays within its maximum", () => {
  for (const field of [
    { type: "boolean", minLength: 1 },
    { type: "text", minLength: 2, maxLength: 1 },
  ])
    expect(
      AiTaskRequestSchema.safeParse({
        kind: "extract_data",
        prompt: "Extract",
        input: "Source",
        fields: [{ name: "value", description: "Value", ...field }],
      }).success,
    ).toBe(false);
});
