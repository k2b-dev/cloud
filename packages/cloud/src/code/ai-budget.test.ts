import { expect, test } from "bun:test";
import { decisionResultFixture } from "../../../core/src/ai-decision-capability.test-fixture";
import { codeAiReferenceCost } from "../../../core/src/code/ai-budget";
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
