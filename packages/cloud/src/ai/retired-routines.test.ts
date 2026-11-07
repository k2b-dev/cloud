import { expect, spyOn, test } from "bun:test";
import { assertInteractiveChatTurn } from "./retired-routines";
import { __aiRuntimeTest, prepareAiChatTurn } from "./runtime";
import { aiConversations } from "./store";
import * as stream from "./stream";

test("routine admission fails before settings, files or model work, even with a mandate", async () => {
  const background = { taskId: "Task01", occurrenceId: "Run001", context: [] };
  const input = {
    conversationId: "chat",
    input: "run",
    userMessage: { role: "user" as const, content: [] },
    background,
    mandate: { id: "mandate", revision: 1 },
  };
  await expect(prepareAiChatTurn(input)).rejects.toThrow("Scheduled chat routines are retired");
  await expect(
    aiConversations.submitChatTurn({
      conversationId: "chat",
      modelId: "model",
      userMessage: input.userMessage,
      runConfig: { input: "run", background, mandate: input.mandate },
    }),
  ).rejects.toThrow("Scheduled chat routines are retired");
});

test("even a malformed retired flag fails closed; Code-origin interactive turns stay admitted", () => {
  for (const background of [null, false, undefined, {}])
    expect(() => assertInteractiveChatTurn({ input: "run", background })).toThrow("routines are retired");
  expect(() => assertInteractiveChatTurn({ input: "run", mandate: {} })).toThrow("routines are retired");
  expect(() => assertInteractiveChatTurn({ input: "run", codeOrigin: { codeId: "Code01" } })).not.toThrow();
});

// Publication is a pure boundary: legacy run metadata must never close a foreground stream.
test.each(["background", "mandate"])("retired routine sweep finalization leaves the interactive chat stream open (%s)", async (legacy) => {
  const config = spyOn(aiConversations, "getTurnRunConfig").mockResolvedValue({
    kind: "chat",
    input: "Run",
    toolSource: { kind: "none" },
    ...(legacy === "background"
      ? { background: { taskId: "task01", occurrenceId: "run001", context: [] } }
      : { mandate: { id: "mandate", revision: 1 } }),
  });
  const publish = spyOn(stream, "publishAiWireEvent").mockResolvedValue(undefined);
  try {
    await __aiRuntimeTest.publishSweepFinished(
      { conversationId: crypto.randomUUID(), turnId: crypto.randomUUID(), attempt: 1, seq: 7 },
      "failed",
    );
    expect(publish).not.toHaveBeenCalled();
  } finally {
    config.mockRestore();
    publish.mockRestore();
  }
});
