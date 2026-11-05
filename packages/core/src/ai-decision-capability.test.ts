import { afterEach, expect, expectTypeOf, spyOn, test } from "bun:test";
import * as ai from "@k2b/cloud/ai";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { geoTestContext } from "@k2b/cloud/services/geo/geo.test-fixture";
import { z } from "zod";
import { compileCapabilities, invokeCompiledCapability } from "../../cloud/src/_internal/capabilities";
import { buildAiCapabilityCatalog, createLoadedAiCapabilityTools } from "../../cloud/src/ai/capabilities";
import { type aiDecisionData, aiDecisionInput, aiDecisionQuery } from "./ai-decision-capability";
import { decisionInputFixture as input, decisionResultFixture as result } from "./ai-decision-capability.test-fixture";
import { aiCapabilities } from "./capabilities";

const context: CapabilityExecutionContext = {
  ...geoTestContext,
  actor: geoTestContext.actor!,
  accessSubject: geoTestContext.accessSubject!,
  user: null,
  locale: "en",
  requestId: "ai-decision",
  origin: "assistant",
  signal: new AbortController().signal,
};
let call: ReturnType<typeof spyOn<typeof ai, "runAiDecision">> | undefined;
afterEach(() => call?.mockRestore());

test("Core publishes one read-only query with typed probabilities and DE/EN presentation", () => {
  const { manifest, presentation } = compileCapabilities("core", aiCapabilities);
  const entry = manifest.queries.find((q) => q.localId === "ai.decide")!;
  expect(entry).toBeDefined();
  expect(entry.inputSchema.required).toEqual(expect.arrayContaining(["task", "state", "questions"]));
  type PublicResult = ai.RunAiDecisionResult<ai.DecisionQuestions>;
  type WireResult = z.output<typeof aiDecisionData>;
  expectTypeOf<PublicResult>().toMatchTypeOf<WireResult>();
  expectTypeOf<WireResult>().toMatchTypeOf<PublicResult>();
  expectTypeOf<keyof PublicResult>().toEqualTypeOf<keyof WireResult>();
  expectTypeOf<keyof PublicResult["usage"]>().toEqualTypeOf<keyof WireResult["usage"]>();
  expectTypeOf<keyof PublicResult["model"]>().toEqualTypeOf<keyof WireResult["model"]>();
  expectTypeOf<Extract<PublicResult["answers"][string], { type: "noul" }>>().toEqualTypeOf<
    Extract<WireResult["answers"][string], { type: "noul" }>
  >();
  expectTypeOf<Extract<PublicResult["answers"][string], { type: "choice" }>>().toEqualTypeOf<
    Extract<WireResult["answers"][string], { type: "choice" }>
  >();
  expectTypeOf<Extract<PublicResult["answers"][string], { type: "score" }>>().toEqualTypeOf<
    Extract<WireResult["answers"][string], { type: "score" }>
  >();
  expect(manifest.actions.some((a) => a.localId === "ai.decide")).toBe(false);
  expect(entry.target).toBeUndefined();
  expect(entry.title).toBe("Ask a decision model");
  expect(presentation?.translations.de?.queries?.["ai.decide"]?.title).toBe("Ein Entscheidungsmodell fragen");
  expect(JSON.stringify(entry.inputSchema)).not.toContain("usageSubject");
  expect(entry.dataSchema).toMatchObject({
    properties: { answers: expect.any(Object), model: expect.any(Object), usage: expect.any(Object) },
  });
});

test.each(["user", "service_account"] as const)(
  "query preserves %s caller, signal and exact answers through provider validation",
  async (kind) => {
    const accessSubject =
      kind === "user"
        ? { type: "user" as const, userId: "person" }
        : { type: "service_account" as const, serviceAccountId: "code-account" };
    call = spyOn(ai, "runAiDecision").mockResolvedValue(result);
    const compiled = compileCapabilities("core", aiCapabilities);
    const outcome = await invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: "ai.decide",
      expectedSchemaHash: compiled.queries.get("ai.decide")!.manifest.schemaHash,
      input,
      context: { ...context, accessSubject },
    });
    expect(outcome).toEqual({ ok: true, data: { data: result } });
    expect(call).toHaveBeenCalledWith({ ...input, usageSubject: accessSubject, appId: "core", signal: context.signal });
  },
);

test("input uses decision limits and rejects invented question kinds and caller overrides", () => {
  for (const invalid of [
    { ...input, usageSubject: { type: "user", userId: "other" } },
    { ...input, task: "x".repeat(121) },
    { ...input, task: " " },
    { ...input, questions: {} },
    { ...input, questions: Object.fromEntries(Array.from({ length: 129 }, (_, n) => [`q${n}`, input.questions.urgent])) },
    { ...input, questions: { q: { type: "text", instructions: "Write prose" } } },
    { ...input, questions: { q: { type: "choice", instructions: "Choose", criteria: { only: null } } } },
    { ...input, questions: { q: { type: "score", instructions: "Rate", criteria: ["only"] } } },
    { ...input, questions: JSON.parse('{"__proto__":{"type":"noul","instructions":"x"}}') },
    { ...input, state: undefined },
    { ...input, images: Array.from({ length: 17 }, () => ({ data: "YQ==", mediaType: "image/png" })) },
  ])
    expect(aiDecisionInput.safeParse(invalid).success).toBe(false);
  expect(aiDecisionInput.safeParse({ ...input, model: { id: "clef" }, images: [{ data: "YQ==", mediaType: "image/png" }] }).success).toBe(
    true,
  );
});

test.each([
  ["decision_images_not_supported", 400],
  ["decision_input_too_large", 400],
  ["decision_not_configured", 503],
  ["quota_exhausted", 429],
  ["quota_usage_unknown", 429],
  ["quota_conflict", 409],
  ["provider_error", 503],
  ["decision_model_unavailable", 403],
  ["decision_input_invalid", 400],
  ["provider_aborted", 499],
  ["model_policy_mismatch", 403],
] as const)("%s stays stable and localized without provider diagnostics", async (code, status) => {
  call = spyOn(ai, "runAiDecision").mockRejectedValue(
    code === "model_policy_mismatch" ? { aiError: { code }, message: "private" } : { code, message: "private" },
  );
  const en = await aiDecisionQuery.run(input, context);
  const de = await aiDecisionQuery.run(input, { ...context, locale: "de" });
  expect(en).toMatchObject({ ok: false, error: { code, status } });
  expect(de).toMatchObject({ ok: false, error: { code, status } });
  if (en.ok || de.ok) throw new Error("Expected failures");
  expect(en.error.message).not.toBe(de.error.message);
  expect(JSON.stringify([en, de])).not.toContain("private");
});

test("unexpected infrastructure failures reach the framework error handler", async () => {
  const failure = new Error("fixture database unavailable");
  call = spyOn(ai, "runAiDecision").mockRejectedValue(failure);
  await expect(aiDecisionQuery.run(input, context)).rejects.toBe(failure);
});

test("Gustav discovers and loads the query as a normal capability tool", async () => {
  const apps = [
    {
      appId: "core",
      appName: "Core",
      appIcon: "ti ti-cloud",
      appDescription: "Platform",
      endpoint: "http://core.test",
      manifest: compileCapabilities("core", aiCapabilities).manifest,
    },
  ];
  const catalog = buildAiCapabilityCatalog(apps);
  const entries = catalog.filter((entry) => entry.operation.localId === "ai.decide");
  expect(entries).toHaveLength(1);
  const entry = entries[0]!;
  expect(entry.kind).toBe("query");
  expect(entry.name).toBe(ai.aiCapabilityId("core", "ai.decide"));
  const tools = createLoadedAiCapabilityTools({
    apps,
    catalog,
    loadedNames: [entry.name],
    actor: context.actor,
    execute: async () => ({ data: result }),
  });
  expect(tools).toHaveLength(1);
  expect(z.toJSONSchema(tools[0]!.def.inputSchema)).toMatchObject({
    properties: { task: expect.any(Object), state: expect.any(Object), questions: expect.any(Object) },
  });
});
