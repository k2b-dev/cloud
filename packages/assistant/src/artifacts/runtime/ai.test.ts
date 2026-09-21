import { expect, test } from "bun:test";
import { createAi } from "./ai";

test("AI namespace sends validated requests and returns simple values", async () => {
  const calls: unknown[] = [];
  const ai = createAi(async (method, args) => {
    calls.push({ method, request: args[0] });
    return ["Summary", "question", ["question"], { ready: true }][calls.length - 1];
  });
  expect(await ai.generateText({ prompt: "Summarize", input: "Text" })).toBe("Summary");
  expect(await ai.classify({ prompt: "Classify", input: "Text", choices: ["question", "other"] })).toBe("question");
  expect(await ai.classifyMany({ prompt: "Classify", input: "Text", choices: ["question", "other"] })).toEqual(["question"]);
  expect(
    await ai.extractData({ prompt: "Extract", input: "Text", fields: [{ name: "ready", type: "boolean", description: "Ready" }] }),
  ).toEqual({ ready: true });
  expect(calls[0]).toMatchObject({ method: "ai", request: { kind: "generate_text", maxOutputChars: 4000 } });
  expect(() => ai.classify({ prompt: "Classify", input: "Text", choices: ["same", "same"] })).toThrow();
  expect(calls).toHaveLength(4);
});
