import type { GenerateResult, StreamEvent } from "@k2b/nessi/ai";

/** The stream a provider sends for one whole answer, so a test can describe the answer as a result. */
export async function* streamAnswer(result: GenerateResult): AsyncGenerator<StreamEvent> {
  for (const [index, block] of result.message.content.entries()) {
    const blockId = `block-${index}`;
    yield block.type === "tool_call"
      ? { type: "block_start", blockId, index, kind: "tool_call", callId: block.id, name: block.name }
      : { type: "block_start", blockId, index, kind: block.type };
    yield { type: "block_end", blockId, index, block };
  }
  yield { type: "usage", usage: result.usage ?? { input: 0, output: 0, total: 0 }, finishReason: result.finishReason };
}
