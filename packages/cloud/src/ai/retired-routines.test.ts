import { expect, test } from "bun:test";
import { assertInteractiveChatTurn } from "./retired-routines";
import { prepareAiChatTurn } from "./runtime";
import { aiConversations } from "./store";

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
