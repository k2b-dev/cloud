import { expect, test } from "bun:test";
import { decisionResultFixture } from "../../../core/src/ai-decision-capability.test-fixture";
import { codeAiBudgetRemainder, codeAiReferenceCost } from "../../../core/src/code/ai-budget";
import { aiModelFixture } from "../ai/model-fixture";

const profiles = [aiModelFixture({ id: "clef", pricing: { inputPerMillion: 1, outputPerMillion: 2 } })];
const result = { ok: true, data: { data: decisionResultFixture } };

test("Code accounts exact returned model usage with shared reference prices", () => {
  expect(codeAiReferenceCost("core.ai.decide", result, profiles, "1")).toBe("0.000046000000");
  expect(
    codeAiReferenceCost(
      "core.ai.decide",
      result,
      [aiModelFixture({ id: "clef", pricing: { inputPerMillion: 0, outputPerMillion: 0 } })],
      "1",
    ),
  ).toBe("0.000000000000");
});

test("unknown usage and failed calls keep the reserved allowance spent", () => {
  for (const response of [
    { ok: false, error: { code: "provider_error" } },
    { ok: true, data: {} },
    { ok: true, data: { data: { ...decisionResultFixture, usage: { input: -1, output: 0 } } } },
    { ok: true, data: { data: { ...decisionResultFixture, model: { id: "unknown" } } } },
  ])
    expect(codeAiReferenceCost("core.ai.decide", response, profiles, "0.5")).toBe("0.5");
  expect(codeAiReferenceCost("core.ai.decide", result, [aiModelFixture({ id: "clef" })], "0.5")).toBe("0");
});

test("known pre-provider refusals and successful AI history reads spend no reference cost", () => {
  for (const code of ["quota_exhausted", "decision_input_invalid", "decision_not_configured", "model_policy_mismatch", "VALIDATION_FAILED"])
    expect(codeAiReferenceCost("core.ai.decide", { ok: false, error: { code } }, profiles, "1")).toBe("0");
  expect(codeAiReferenceCost("core.ai.skills.list", { ok: true, data: { data: { skills: [] } } }, profiles, "1")).toBe("0");
});

test("generation uses measured pricing and conservatively retains unknown usage", () => {
  const generated = { ok: true, data: { data: { output: "Summary", model: { id: "clef" }, usage: { input: 40, output: 3, total: 43 } } } };
  expect(codeAiReferenceCost("core.ai.generate", generated, profiles, "1")).toBe("0.000046000000");
  expect(
    codeAiReferenceCost("core.ai.generate", { ok: true, data: { data: { ...generated.data.data, usage: null } } }, profiles, "1"),
  ).toBe("1");
  for (const code of ["ai_input_too_large", "ai_model_unavailable"])
    expect(codeAiReferenceCost("core.ai.generate", { ok: false, error: { code } }, profiles, "1")).toBe("0");
  for (const code of ["ai_invalid_output", "quota_exhausted", "quota_usage_unknown", "quota_conflict"])
    expect(codeAiReferenceCost("core.ai.generate", { ok: false, error: { code } }, profiles, "1")).toBe("1");
});

test("attempt and daily admission use exact picounits and clamp overspend at zero", () => {
  expect(codeAiBudgetRemainder(1, "0.999999999999")).toBe(1n);
  expect(codeAiBudgetRemainder(0.000092, "0.000046000000")).toBe(46_000_000n);
  expect(codeAiBudgetRemainder(0, "0")).toBe(0n);
  expect(codeAiBudgetRemainder(1, "1")).toBe(0n);
  expect(codeAiBudgetRemainder(1, "2")).toBe(0n);
});

test("failed generation settles measured repairs and known zero but keeps unknown outcomes spent", () => {
  const failed = (usage: unknown) => ({
    ok: false,
    error: { code: "quota_exhausted", details: { aiUsage: { model: { id: "clef" }, usage } } },
  });
  expect(codeAiReferenceCost("core.ai.generate", failed({ input: 40, output: 3 }), profiles, "1")).toBe("0.000046000000");
  expect(codeAiReferenceCost("core.ai.generate", failed({ input: 0, output: 0 }), profiles, "1")).toBe("0.000000000000");
  for (const usage of [null, { input: -1, output: 0 }, { input: 2 }])
    expect(codeAiReferenceCost("core.ai.generate", failed(usage), profiles, "1")).toBe("1");
});

test("loop settlement sums every model and failed fallback without freeing unknown usage", () => {
  const models = [aiModelFixture({ id: "vision", pricing: { inputPerMillion: 2, outputPerMillion: 4 } }), ...profiles];
  const usage = {
    input: 30,
    output: 10,
    byModel: [
      { model: { id: "vision" }, input: 10, output: 5 },
      { model: { id: "clef" }, input: 20, output: 5 },
    ],
  };
  const value = { model: { id: "clef" }, usage };
  const success = { ok: true, data: { data: value } };
  for (const capability of ["core.ai.generate", "core.ai.decide"]) {
    expect(codeAiReferenceCost(capability, success, models, "1")).toBe("0.000070000000");
    expect(
      codeAiReferenceCost(capability, { ok: false, error: { code: "quota_exhausted", details: { aiUsage: value } } }, models, "1"),
    ).toBe("0.000070000000");
    expect(
      codeAiReferenceCost(capability, { ok: false, error: { code: "quota_exhausted", details: { aiUsageUnknown: true } } }, models, "1"),
    ).toBe("1");
  }
});
