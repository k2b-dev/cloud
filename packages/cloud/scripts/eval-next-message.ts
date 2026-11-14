import { parseArgs } from "node:util";
import { complete } from "@k2b/nessi/ai";
import { AI_NEXT_MESSAGE_DESCRIPTION, createAiNextMessageTool } from "../src/ai/next-message";
import {
  checkNextMessageEval,
  NEXT_MESSAGE_EVAL_CASES,
  nextMessageEvalInstruction,
  nextMessageEvalMessages,
} from "../src/ai/next-message.eval";
import { resolveAiModel } from "../src/ai/settings";
import { composeAiSystemPrompt } from "../src/ai/system-prompt";
import { sql } from "../src/runtime/clients";
import { initializePlatform } from "../src/start";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    model: { type: "string", default: "balanced" },
    out: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Usage: bun packages/cloud/scripts/eval-next-message.ts [--model balanced|fast] [--out report.json]\n\nReads the installation's model catalog (DATABASE_URL, REDIS_URL, APP_SECRET), then evaluates 15 invented frozen endings. No chats or settings are written. Uses the configured class and its credentials; no fallback to a different provider. Sequential requests; at most 120 seconds per case.",
  );
  process.exit(0);
}
if (values.model !== "fast" && values.model !== "balanced") throw new Error("--model must be balanced or fast");
await initializePlatform({ appId: "assistant", source: "env" });
try {
  const { provider, profile } = await resolveAiModel(undefined, { class: values.model });
  const tool = createAiNextMessageTool();
  const results = [];
  for (const fixture of NEXT_MESSAGE_EVAL_CASES) {
    const generated = await complete(provider, {
      systemPrompt:
        composeAiSystemPrompt({
          globalInstructions: "",
          now: new Date("2026-11-07T09:00:00Z"),
          locale: fixture.language,
          toolHints: [{ name: "suggest_next_message", hint: AI_NEXT_MESSAGE_DESCRIPTION }],
        }) + nextMessageEvalInstruction(fixture),
      messages: nextMessageEvalMessages(fixture),
      tools: [{ name: tool.def.name, description: tool.def.description, inputSchema: tool.def.inputSchema.toJSONSchema() }],
      temperature: 0,
      maxOutputTokens: 1024,
      reasoningEffort: profile.reasoningEffort,
      signal: AbortSignal.timeout(120_000),
    });
    const calls = generated.message.content.filter((block) => block.type === "tool_call");
    const first = calls.find((block) => block.name === "suggest_next_message");
    const checked = checkNextMessageEval(fixture, first?.args.text);
    if (calls.length > 1) checked.problems.push("multiple_calls");
    checked.pass = checked.problems.length === 0;
    results.push(checked);
    console.log(`${fixture.id}: ${checked.pass ? "pass" : checked.problems.join(", ")} · ${JSON.stringify(checked.raw ?? null)}`);
  }
  const positives = results.filter((result) => result.id.startsWith("J") && result.pass).length;
  // Only cases that expect no suggestion count; N8–N10 allow one (plan: other text, no number, German).
  const negativeSuggestions = results.filter((result) => result.problems.includes("unwanted") && result.text !== null).length;
  const unwanted = results.filter((result) => result.id.startsWith("N") && result.problems.includes("unwanted")).length;
  const privacyOrRepetition = results.filter((result) =>
    result.problems.some((problem) => problem === "repetition" || problem.startsWith("private_data:") || problem.startsWith("name:")),
  ).length;
  const constraints = results.every((result) => result.problems.every((problem) => ["missing", "unwanted", "intent"].includes(problem)));
  const pass = positives >= 4 && negativeSuggestions <= 1 && privacyOrRepetition === 0 && constraints;
  const report = {
    class: values.model,
    model: profile.model,
    fixtureTime: "2026-11-07T09:00:00Z",
    positives,
    negativeSuggestions,
    unwanted,
    privacyOrRepetition,
    pass,
    results,
  };
  if (values.out) await Bun.write(values.out, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ class: values.model, model: profile.model, positives, negativeSuggestions, unwanted, privacyOrRepetition, pass }),
  );
  process.exitCode = pass ? 0 : 1;
} finally {
  await sql.close();
}
