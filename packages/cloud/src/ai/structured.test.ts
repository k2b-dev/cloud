import { describe, expect, test } from "bun:test";
import { nessi, type Provider, StructuredOutputError } from "@k2b/nessi";
import { z } from "zod";
import { AiBackgroundCostError } from "./inference-calls";
import { selectAiWorkflowModelId, structuredProviderFailure } from "./structured";

describe("structured provider failures", () => {
  test("restores the original provider error wrapped by nessi direct mode", async () => {
    const failure = new AiBackgroundCostError();
    const provider = {
      name: "test",
      family: "openai-compatible",
      model: "test",
      capabilities: { streaming: false, tools: false, images: false, thinking: false, usage: false },
      complete: async () => {
        throw failure;
      },
      stream: async function* () {
        throw new Error("Unused stream");
      },
    } satisfies Provider;
    let caught: unknown;
    try {
      await nessi.structured({ provider, input: "Test", output: z.object({ answer: z.string() }) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StructuredOutputError);
    expect(structuredProviderFailure(caught)).toBe(failure);
  });

  test("only unwraps provider failure codes with an own cause", () => {
    const failure = new Error("Provider failure");
    expect(structuredProviderFailure(new StructuredOutputError("Aborted", "aborted", { cause: failure }))).toBe(failure);
    for (const error of [
      new StructuredOutputError("Invalid output", "invalid_output", { cause: failure }),
      new StructuredOutputError("Loop failed", "loop_failed"),
      new StructuredOutputError("Loop failed", "loop_failed", Object.create({ cause: failure })),
      failure,
    ]) {
      expect(structuredProviderFailure(error)).toBe(error);
    }
  });
});

describe("workflow AI model selection", () => {
  test("uses action, workflow, background, then platform default precedence", () => {
    expect(selectAiWorkflowModelId({ requestedModelId: "action", workflowModelId: "workflow", backgroundModelId: "background" })).toBe(
      "action",
    );
    expect(selectAiWorkflowModelId({ workflowModelId: "workflow", backgroundModelId: "background" })).toBe("workflow");
    expect(selectAiWorkflowModelId({ backgroundModelId: "background" })).toBe("background");
    expect(selectAiWorkflowModelId({})).toBeUndefined();
  });

  test("ignores blank overrides", () => {
    expect(selectAiWorkflowModelId({ requestedModelId: " ", workflowModelId: "", backgroundModelId: "background" })).toBe("background");
  });
});
