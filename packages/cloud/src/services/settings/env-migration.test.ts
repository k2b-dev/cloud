import { afterEach, expect, test } from "bun:test";
import { env } from "../../config/env";
import { CORE_SETTINGS } from "./core-settings";
import { toLegacySettingDefs, validateSettingValue } from "./defaults";
import { validateNetworkAllowlist, validateTrustedProxies } from "./validation";

const defs = toLegacySettingDefs(CORE_SETTINGS);
const previous = process.env.WORKFLOW_AI_ATTEMPT_TIMEOUT_MS;
afterEach(() => {
  if (previous === undefined) delete process.env.WORKFLOW_AI_ATTEMPT_TIMEOUT_MS;
  else process.env.WORKFLOW_AI_ATTEMPT_TIMEOUT_MS = previous;
});
test("bootstrap imports only explicitly supplied environment values", () => {
  delete process.env.WORKFLOW_AI_ATTEMPT_TIMEOUT_MS;
  expect(env.WORKFLOW_AI_ATTEMPT_TIMEOUT_MS).toBe(60_000);
  expect(CORE_SETTINGS["ai.workflow_attempt_timeout_ms"].envBootstrap()).toBeUndefined();
  process.env.WORKFLOW_AI_ATTEMPT_TIMEOUT_MS = "12345";
  expect(CORE_SETTINGS["ai.workflow_attempt_timeout_ms"].envBootstrap()).toBe(12345);
  process.env.WORKFLOW_AI_ATTEMPT_TIMEOUT_MS = "broken";
  expect(() => CORE_SETTINGS["ai.workflow_attempt_timeout_ms"].envBootstrap()).toThrow();
});
test("network lists preserve strict host, port and CIDR validation on writes", () => {
  for (const value of [["smtp.internal:465", "[::1]:993", "10.0.0.0/8"], []]) expect(validateNetworkAllowlist(value)).toBeUndefined();
  for (const value of [["0.0.0.0/0"], ["::/0"], ["10.0.0.1/8"], ["http://internal"], ["smtp:0"], [42]])
    expect(validateNetworkAllowlist(value)).toBeDefined();
  const def = defs.find((d) => d.key === "outgoing_mail.allowed_targets")!;
  expect(validateSettingValue(def, [42]).ok).toBe(false);
  expect(validateSettingValue(def, ["0.0.0.0/0"]).ok).toBe(false);
  expect(validateSettingValue(def, "smtp.internal:465,10.0.0.0/8")).toEqual({ ok: true, value: ["smtp.internal:465", "10.0.0.0/8"] });
});
test("trusted proxies accept only IPs and bounded CIDRs", () => {
  expect(validateTrustedProxies(["127.0.0.1", "::1", "10.0.0.0/8"])).toBeUndefined();
  for (const value of [["proxy.internal"], ["::/0"], ["0.0.0.0/0"], ["10.0.0.0/33"], ["fe80::1%eth0"]])
    expect(validateTrustedProxies(value)).toBeDefined();
});
test("AI limits reject malformed JSON, unknown fields, fractions and nonpositive limits", () => {
  const budget = defs.find((d) => d.key === "ai.workflow_budget")!;
  expect(validateSettingValue(budget, budget.default).ok).toBe(true);
  for (const value of [
    "{}",
    "broken",
    JSON.stringify({ ...JSON.parse(String(budget.default)), globalConcurrent: 0 }),
    JSON.stringify({ ...JSON.parse(String(budget.default)), extra: 1 }),
  ])
    expect(validateSettingValue(budget, value).ok).toBe(false);
  const timeout = defs.find((d) => d.key === "ai.workflow_attempt_timeout_ms")!;
  for (const value of [0, -1, 0.5, Infinity]) expect(validateSettingValue(timeout, value).ok).toBe(false);
});
