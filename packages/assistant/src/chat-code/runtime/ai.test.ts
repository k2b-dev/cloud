import { expect, test } from "bun:test";
import { createAi } from "./ai";

test("AI namespace sends validated requests and returns simple values", async () => {
  const calls: unknown[] = [];
  const ai = createAi(async (method, args) => {
    calls.push({ method, request: args[0] });
    return ["Summary", "question", ["question"], { ready: true, missing: null }][calls.length - 1];
  });
  expect(await ai.text({ prompt: "Summarize", input: "Text" })).toBe("Summary");
  expect(await ai.classify({ prompt: "Classify", input: "Text", choices: ["question", "other"] })).toBe("question");
  expect(await ai.classify({ multiple: true, prompt: "Classify", input: "Text", choices: ["question", "other"] })).toEqual(["question"]);
  expect(
    await ai.extract({ prompt: "Extract", input: "Text", fields: [{ name: "ready", type: "boolean", description: "Ready" }] }),
  ).toEqual({ ready: true, missing: null });
  expect(calls[0]).toMatchObject({ method: "ai", request: { kind: "generate_text", maxOutputChars: 4000 } });
  await expect(ai.classify({ prompt: "Classify", input: "Text", choices: ["same", "same"] })).rejects.toThrow();
  expect(calls).toHaveLength(4);
});
