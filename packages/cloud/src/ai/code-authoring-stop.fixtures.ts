import { defineTool, memoryStore, nessi, type Provider } from "@k2b/nessi";
import { z } from "zod";
import { createCodeAuthoringTurnBudget } from "./code-authoring-turn";
import type { AiStoredMessage } from "./types";

const at = "2026-11-14T12:00:00.000Z";

/** Real nessi + budget termination, using the same append-time receipt as the durable session store. */
export async function createStoppedAuthoringFixture(locale = "en") {
  const guard = createCodeAuthoringTurnBudget({
    priorCalls: { calls: 0, inputTokens: 0 },
    selected: true,
    finishedToolCalls: [
      {
        name: "code_write",
        status: "completed",
        args: { codeId: "private-id" },
        result: {
          version: 1,
          draft: {
            codeId: "private-id",
            entry: "task.ts",
            baseVersionId: null,
            files: [{ path: "task.ts", bytes: 200 }],
            tests: [],
            expiresAt: "2026-11-21T12:00:00.000Z",
          },
        },
      },
      { name: "code_check", status: "completed", args: { codeId: "private-id" }, result: { version: 1, result: { ok: true } } },
    ],
  });
  let calls = 0;
  const provider: Provider = {
    name: "stub",
    model: "stub",
    family: "openai-compatible",
    capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: false },
    async *stream() {
      calls++;
      const id = `test-${calls}`;
      yield { type: "block_start", blockId: id, index: 0, kind: "tool_call", callId: id, name: "code_test" };
      yield {
        type: "block_end",
        blockId: id,
        index: 0,
        block: { type: "tool_call", id, name: "code_test", args: { codeId: "private-id" } },
      };
    },
  };
  const tool = defineTool({ name: "code_test", description: "Test", inputSchema: z.object({ codeId: z.string() }) }).server(async () => ({
    version: 1,
    ok: false,
    error: "code_test_invalid_fixture",
    diagnostics: [],
    cases: [],
  }));
  const memory = memoryStore();
  const messages: AiStoredMessage[] = [];
  const loop = nessi({
    systemPrompt: "Prepare the requested task; verify the draft before saving a version.",
    provider: guard.wrap(provider),
    input: locale === "de" ? "Bereite eine wöchentliche Aufgabenübersicht vor." : "Prepare a weekly task summary.",
    tools: guard.tools([tool]),
    maxTurns: 20,
    store: {
      load: () => memory.load(),
      append: async (message, opts) => {
        await memory.append(message, opts);
        messages.push({
          id: `message-${messages.length}`,
          shortId: "short",
          conversationId: "chat",
          seq: messages.length + 1,
          kind: "message",
          message,
          loopId: "turn",
          modelId: "stub",
          providerModel: "stub",
          usage: null,
          stopReason: null,
          loopAggregate: null,
          loopDoneReason: "stop",
          compactedAt: null,
          meta: guard.stopped() ? { codeAuthoringStop: guard.stopped()! } : null,
          createdAt: at,
        });
      },
    },
  });
  try {
    for await (const _event of loop) {
      /* Drive until all tools settle and the local stop is saved. */
    }
  } finally {
    loop.abort();
  }
  return { messages, calls, state: guard.stopped() };
}
