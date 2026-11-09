import { expect, mock, test } from "bun:test";
import type { Provider } from "@k2b/nessi";
import { codeAiModelBudget } from "../../../core/src/code/ai-loop";
import type { AiResolvedModel } from "../ai";
import { streamAnswer } from "../ai/answer-stream.test-fixture";
import { aiModelFixture } from "../ai/model-fixture";

const consume = async (provider: Provider) => {
  for await (const _event of provider.stream({ messages: [], maxOutputTokens: 10 })) {
    /* drain */
  }
};
test("every model step reauthorizes and reserves its worst-case cost before provider work", async () => {
  const invoked = mock(() => {}),
    check = mock(async () => {});
  const model: AiResolvedModel = {
    model: { id: "chat" },
    profile: aiModelFixture({ pricing: { inputPerMillion: 1000, outputPerMillion: 1000 } }),
    provider: {
      name: "fixture",
      family: "openai-compatible",
      model: "chat",
      capabilities: { streaming: true, tools: true, images: false, usage: true, thinking: false },
      async *stream() {
        invoked();
        yield* streamAnswer({
          message: { role: "assistant", content: [] },
          usage: { input: 1, output: 1, total: 2 },
          finishReason: "stop",
        });
      },
    },
  };
  const budget = codeAiModelBudget("0.020000000000", check),
    guarded = budget(model);
  await consume(guarded.provider);
  await expect(consume(guarded.provider)).rejects.toMatchObject({ code: "code_ai_budget_limit" });
  expect(check).toHaveBeenCalledTimes(2);
  expect(invoked).toHaveBeenCalledTimes(1);
  check.mockRejectedValue(Object.assign(new Error("Approval revoked"), { code: "code_approval_revoked" }));
  await expect(consume(guarded.provider)).rejects.toMatchObject({ code: "code_approval_revoked" });
  expect(invoked).toHaveBeenCalledTimes(1);
});
