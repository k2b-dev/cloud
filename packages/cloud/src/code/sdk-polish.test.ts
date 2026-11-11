import { afterAll, beforeAll, expect, test } from "bun:test";
import { aiDecisionQuery } from "../../../core/src/ai-decision-capability";
import { aiGenerationQuery } from "../../../core/src/ai-generation-capability";
import { acceptanceChecker } from "../../../core/src/code/acceptance.test-fixture";
import { compileCapabilityManifest } from "../capabilities/testing";
import { defineCapabilities } from "../contracts/capabilities";
import { analyzeCode } from "./checker-analysis";
import { codeCheckerMessages } from "./checker-messages";
import { generateCodeSdk } from "./generator";
import { sdkFixture } from "./sdk.test-fixture";

const ai = compileCapabilityManifest(
  "core",
  defineCapabilities({ protocolVersion: 2, queries: { "ai.decide": aiDecisionQuery, "ai.generate": aiGenerationQuery } }),
);
const sdk = generateCodeSdk([sdkFixture(), ai], { mode: "personal" });
let checker: Awaited<ReturnType<typeof acceptanceChecker>>;
beforeAll(async () => {
  checker = await acceptanceChecker();
});
afterAll(async () => {
  await checker?.close();
});
const lean = generateCodeSdk([sdkFixture()], { mode: "personal" });
const check = (source: string, locale = "en") =>
  checker.check({
    sdk: source.includes("core.ai") ? sdk : lean,
    entry: "code.ts",
    files: { "code.ts": source },
    aiOperations: ["core.ai.decide", "core.ai.generate"],
    locale,
  });

test("optional inputs and named exported types coexist with explicit inputs", async () => {
  const result =
    await check(`import { app, work_shop, type Work$hshop_Catalog_ListInput, type Work$hshop_Catalog_ListData, type CodeErrorCode, type KnownCodeErrorCode } from "@sdk";
app.schedule({ cron: "0 8 * * *", name: "catalog" }, async () => {
  const input: Work$hshop_Catalog_ListInput = {};
  const known: KnownCodeErrorCode = "code_code_false";
  const custom: CodeErrorCode = "application_specific_refusal";
  const a: Work$hshop_Catalog_ListData = (await work_shop.catalog.list()).data;
  await work_shop.catalog.list(input); await work_shop.workshop("w").stock.list();
});`);
  expect(result.ok ? [] : result.diagnostics).toEqual([]);
});

test("required fields still require an input", async () => {
  const missing = await check(
    `import { app, work_shop } from "@sdk"; app.schedule({ cron: "0 8 * * *", name: "missing" }, async () => { await work_shop.workshop("w").item.create(); });`,
  );
  expect(missing.ok).toBe(false);
});

test("handler-last routes retain public flags, visitor checks and permission attribution", async () => {
  const result = await check(`import { app, work_shop } from "@sdk";
app.get("/public", { public: true, layout: "plain" }, c => c.text(c.req.method + c.req.path));
app.post("/private", { public: false }, async c => { if (!c.user) return c.text("No", 403); await work_shop.catalog.list(); return c.json({ path: c.req.path }); });
app.get("/legacy", c => c.text("legacy"), { public: true });
app.get("/empty", {}, c => c.text(c.user?.name ?? ""));`);
  expect(result.ok ? [] : result.diagnostics).toEqual([]);
  if (!result.ok) return;
  expect(result.manifest.entrypoints.map((e) => e.route)).toEqual([
    { method: "GET", path: "/public", public: true, layout: "plain" },
    { method: "POST", path: "/private", public: false },
    { method: "GET", path: "/legacy", public: true },
    { method: "GET", path: "/empty", public: false },
  ]);
  expect(result.permissions).toContainEqual(
    expect.objectContaining({ operation: "work-shop.catalog.list", entrypoints: ["route:POST:/private"] }),
  );
  expect(result.warnings).toEqual([]);
});

test("AI output and answers offer precise opt-in types while preserving legacy calls", async () => {
  const result = await check(`import { app, core, type Core_Ai_DecideInput, type Core_Ai_GenerateInput } from "@sdk";
app.schedule({ cron: "0 8 * * *", name: "ai" }, async () => {
  const result = await core.ai.decide({ task: "triage", input: {}, questions: { yes: { type: "boolean", instructions: "Relevant?" }, category: { type: "choice", instructions: "Category?", criteria: { one: "One", two: "Two" } }, rating: { type: "score", instructions: "Rate?", criteria: ["Low", "High"] } } });
  const value: boolean = result.data.answers.yes.value;
  const confidence: number = result.data.answers.yes.confidence;
  const choice: "one" | "two" = result.data.answers.category.choice;
  const score: number = result.data.answers.rating.score;
  const oldRequest = { task: "old", state: {}, questions: { yes: { type: "noul", instructions: "Relevant?" } } } satisfies Core_Ai_DecideInput;
  const old = await core.ai.decide<typeof oldRequest>(oldRequest);
  const probability: number = old.data.answers.yes.probability;
  const textRequest = { task: "text", prompt: "Summarize", input: {}, output: { type: "text" } } satisfies Core_Ai_GenerateInput;
  const text = await core.ai.generate<typeof textRequest>(textRequest);
  const content: string = text.data.output;
  const jsonRequest = { task: "json", prompt: "Extract", input: {}, output: { type: "json", schema: { type: "object", properties: { name: { type: "string" }, done: { type: "boolean" } }, required: ["name"] as ["name"], additionalProperties: false } } } satisfies Core_Ai_GenerateInput;
  const json = await core.ai.generate<typeof jsonRequest>(jsonRequest);
  const name: string = json.data.output.name; const done: boolean | undefined = json.data.output.done;
  const required: string[] = ["name"];
  const broadRequest = { ...jsonRequest, output: { ...jsonRequest.output, schema: { ...jsonRequest.output.schema, required } } };
  const broad = await core.ai.generate<typeof broadRequest>(broadRequest);
  const optionalFields: typeof broad.data.output = {};
  const maybeName: string | undefined = broad.data.output.name;
});`);
  expect(result.ok ? [] : result.diagnostics).toEqual([]);
});

test("unknown members hint at an existing SDK path and diagnostics follow locale", async () => {
  const source = `import { app, work_shop } from "@sdk"; app.schedule({ cron: "0 8 * * *", name: "hint" }, async () => { await work_shop.workshop("w").catalog.list(); });`;
  const request = { sdk: lean, entry: "code.ts", files: { "code.ts": source }, aiOperations: [] };
  const en = analyzeCode({ ...request, locale: "en" });
  const de = analyzeCode({ ...request, locale: "de" });
  expect(codeCheckerMessages.check()).toEqual([]);
  expect(en.diagnostics.some((d) => d.message.includes("exists under `work_shop.catalog.list`"))).toBe(true);
  expect(en.diagnostics.map((d) => d.code)).toEqual(de.diagnostics.map((d) => d.code));
  expect(en.diagnostics[0]?.message).not.toBe(de.diagnostics[0]?.message);
});

test("code: false keeps its diagnostic code and adds a compatibility alias", () => {
  const result = analyzeCode({
    sdk: lean,
    entry: "code.ts",
    aiOperations: [],
    locale: "en",
    files: {
      "code.ts":
        'import { app, work_shop } from "@sdk"; app.schedule({ cron: "0 8 * * *", name: "blocked" }, async () => { await work_shop.workshop("w").outside.change({}); });',
    },
  });
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "code_code_false", aliases: ["code_false"] }));
});

test("unknown member references also name the existing SDK path", () => {
  const result = analyzeCode({
    sdk: lean,
    entry: "code.ts",
    aiOperations: [],
    locale: "en",
    files: {
      "code.ts":
        'import { app, work_shop } from "@sdk"; app.schedule({ cron: "0 8 * * *", name: "hint" }, () => { const method = work_shop.workshop("w").catalog.list; });',
    },
  });
  expect(result.diagnostics.some((d) => d.message.includes("exists under `work_shop.catalog.list`"))).toBe(true);
});

test("legacy any-typed handlers keep their route options and entrypoints", () => {
  const result = analyzeCode({
    sdk: lean,
    entry: "code.ts",
    aiOperations: [],
    files: {
      "code.ts": `import { app, type CodeContext } from "@sdk";
const handler = (c: CodeContext) => c.text("ok");
app.get("/legacy", handler as any);
app.get("/legacy-public", handler as any, { public: true });`,
    },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.entrypoints.map((entry) => entry.route)).toEqual([
    { method: "GET", path: "/legacy", public: false },
    { method: "GET", path: "/legacy-public", public: true },
  ]);
});

test("legacy AI calls preserve broad JSON and decision discriminator narrowing", async () => {
  const result = await check(`import { app, core, type Core_Ai_GenerateData, type Core_Ai_DecideData } from "@sdk";
app.schedule({ cron: "0 8 * * *", name: "legacy-ai" }, async () => {
  const generated = await core.ai.generate({ task: "summary", prompt: "Summarize", input: {}, output: { type: "text" } });
  const envelope: Awaited<ReturnType<typeof core.ai.generate>> = generated;
  const generatedData: Core_Ai_GenerateData = envelope.data;
  const output = generated.data.output;
  if (typeof output === "object" && output !== null && "text" in output && typeof output.text === "string") {
    const summary: string = output.text;
  }
  const decision = await core.ai.decide({ task: "legacy", state: {}, questions: { yes: { type: "noul", instructions: "Relevant?" } } });
  const decisionEnvelope: Awaited<ReturnType<typeof core.ai.decide>> = decision;
  const decisionData: Core_Ai_DecideData = decisionEnvelope.data;
  const answer = decision.data.answers.yes;
  if (answer?.type === "choice") { const choice: string = answer.choice; }
  if (answer?.type === "score") { const score: number = answer.score; }
  if (answer?.type === "noul") { const value: boolean = answer.value; }
});`);
  expect(result.ok ? [] : result.diagnostics).toEqual([]);
});
