import { expect, test } from "bun:test";
import { decisionResultFixture } from "../../../core/src/ai-decision-capability.test-fixture";
import { codeAiBudgetRemainder, codeAiReferenceCost } from "../../../core/src/code/ai-budget";
import { aiModelFixture } from "../ai/model-fixture";

const profiles = [aiModelFixture({ id: "clef", pricing: { inputPerMillion: 1, outputPerMillion: 2 } })];
const result = { ok: true, data: decisionResultFixture };

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
    { ok: true, data: { ...decisionResultFixture, usage: { input: -1, output: 0 } } },
    { ok: true, data: { ...decisionResultFixture, model: { id: "unknown" } } },
  ])
    expect(codeAiReferenceCost("core.ai.decide", response, profiles, "0.5")).toBe("0.5");
  expect(codeAiReferenceCost("core.ai.decide", result, [aiModelFixture({ id: "clef" })], "0.5")).toBe("0");
});

test("known pre-provider refusals and successful AI history reads spend no reference cost", () => {
  for (const code of ["quota_exhausted", "decision_input_invalid", "decision_not_configured", "model_policy_mismatch", "VALIDATION_FAILED"])
    expect(codeAiReferenceCost("core.ai.decide", { ok: false, error: { code } }, profiles, "1")).toBe("0");
  expect(codeAiReferenceCost("core.ai.skills.list", { ok: true, data: { skills: [] } }, profiles, "1")).toBe("0");
});

test("generation uses measured pricing and conservatively retains unknown usage", () => {
  const generated = { ok: true, data: { output: "Summary", model: { id: "clef" }, usage: { input: 40, output: 3, total: 43 } } };
  expect(codeAiReferenceCost("core.ai.generate", generated, profiles, "1")).toBe("0.000046000000");
  expect(codeAiReferenceCost("core.ai.generate", { ok: true, data: { ...generated.data, usage: null } }, profiles, "1")).toBe("1");
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
