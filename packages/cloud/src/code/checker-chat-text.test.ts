import { expect, test } from "bun:test";
import { aiChatSendAction } from "../../../core/src/ai-chat-send";
import { aiDecisionQuery } from "../../../core/src/ai-decision-capability";
import { aiGenerationQuery } from "../../../core/src/ai-generation-capability";
import { compileCapabilityManifest } from "../capabilities/testing";
import { analyzeCode } from "./checker-analysis";
import { generateCodeSdk } from "./generator";
import type { CodeSdkMode } from "./types";

const manifest = compileCapabilityManifest("core", {
  protocolVersion: 2,
  types: { "ai.chat": { title: "Chat", description: "An owned chat." } },
  queries: { "ai.generate": aiGenerationQuery, "ai.decide": aiDecisionQuery },
  actions: { "ai.chat.send": aiChatSendAction },
});
const analyze = (body: string, mode: Exclude<CodeSdkMode, "resource"> = "personal", files: Record<string, string> = {}) =>
  analyzeCode({
    sdk: generateCodeSdk([manifest], { mode }),
    entry: "code.ts",
    aiOperations: ["core.ai.chat.send"],
    files: {
      "code.ts": `import { app, core } from "@sdk";
${mode === "personal" ? 'app.schedule({ cron: "0 8 * * *", name: "send" }, async () => {' : "export default async () => {"}
const data = String(Date.now());
${body}
${mode === "personal" ? "}); export default app;" : "};"}`,
      ...files,
    },
  });
const errors = (body: string) => analyze(body).diagnostics.filter((d) => d.code === "code_chat_text_fixed");

test.each([
  'await core.ai.chat("Chat23").send({ text: "Confirm the supplied number.", context: data, idempotencyKey: "key" });',
  'const text = "Confirm the supplied number."; await core.ai.chat("Chat23").send({ text, context: data, idempotencyKey: "key" });',
  'const instructions = "Confirm " + "the number."; await core.ai.chat("Chat23").send({ text: instructions, context: data, idempotencyKey: "key" });',
  'const text = "Confirm the number." as const; await core.ai.chat("Chat23").send({ text, idempotencyKey: "key" });',
])("fixed chat instructions leave changing context as data: %s", (body) => {
  const result = analyze(body);
  expect(result.diagnostics).toEqual([]);
  expect(result.permissions).toContainEqual(expect.objectContaining({ operation: "core.ai.chat.send" }));
  expect(result.ai).toBe(true);
});

test.each([
  'await core.ai.chat("Chat23").send({ text: data, idempotencyKey: "key" });',
  'const text = data; await core.ai.chat("Chat23").send({ text, idempotencyKey: "key" });',
  'let text = "Fixed"; text = data; await core.ai.chat("Chat23").send({ text, idempotencyKey: "key" });',
  'await core.ai.chat("Chat23").send({ text: `Result: ${data}`, idempotencyKey: "key" });',
  'await core.ai.chat("Chat23").send({ text: data as "Fixed", idempotencyKey: "key" });',
  'const input = { text: "Fixed", idempotencyKey: "key" }; input.text = data; await core.ai.chat("Chat23").send(input);',
  'const input = { text: data }; await core.ai.chat("Chat23").send({ text: "Fixed", ...input, idempotencyKey: "key" });',
  'async function send(text: "Fixed") { await core.ai.chat("Chat23").send({ text, idempotencyKey: "key" }); }',
  'await core.ai.chat("Chat23").send({ text: "Fixed", ["te" + "xt"]: data, idempotencyKey: "key" });',
  'const { text } = { text: data }; await core.ai.chat("Chat23").send({ text, idempotencyKey: "key" });',
])("saved Code rejects dynamic or mutable chat instructions: %s", (body) => {
  expect(errors(body)).toHaveLength(1);
});

test("fixed imported const instructions are allowed; a claimed literal type is insufficient", () => {
  for (const [initializer, expected] of [
    ['"Confirm the number."', false],
    ['String(Date.now()) as "Fixed"', true],
  ] as const) {
    const result = analyze('await core.ai.chat("Chat23").send({ text: instructions, idempotencyKey: "key" });', "personal", {
      "instructions.ts": `export const text = ${initializer};`,
      "code.ts": `import { app, core } from "@sdk"; import { text as instructions } from "./instructions";
app.schedule({ cron: "0 8 * * *", name: "send" }, async () => { await core.ai.chat("Chat23").send({ text: instructions, idempotencyKey: "key" }); }); export default app;`,
    });
    expect(result.diagnostics.some((d) => d.code === "code_chat_text_fixed")).toBe(expected);
  }
});

test("one-shot code_run is exempt from the saved-Code instruction rule", () => {
  expect(analyze('await core.ai.chat("Chat23").send({ text: data, idempotencyKey: "key" });', "code_run").diagnostics).toEqual([]);
});

test.each(["generate", "decide"])("saved Code cannot let an AI %s tool choose chat instructions", (method) => {
  expect(
    errors(`await core.ai.${method}({ task: "fixture", prompt: "Read the facts.", input: data, tools: [core.ai.chat("Chat23").send] });`),
  ).toHaveLength(1);
});
