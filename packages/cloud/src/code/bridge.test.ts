import { expect, test } from "bun:test";
import { compileCapabilities } from "../_internal/capabilities";
import { codeHttpOriginAllowed } from "../api/capabilities";
import { bridgeSkillReadQuery } from "./bridge.test-fixture";
import { codeBridgeDispatchRefusalKind, codeBridgeLocalRefusalKind } from "./bridge-contract";

test("Code HTTP refuses every own origin, credentials and non-HTTPS URLs", () => {
  const own = ["https://cloud.example", "https://cloud.example:8443", "http://app-core:3000"];
  for (const url of [
    "https://cloud.example/secret",
    "https://cloud.example:443/a",
    "https://CLOUD.EXAMPLE/a",
    "https://cloud.example./a",
    "https://cloud.example../a",
    "https://cloud.example.../a",
    "https://cloud.example:8443/a",
    "http://app-core:3000/a",
    "http://external.example/a",
    "file:///etc/passwd",
    "https://user:password@external.example/a",
    "invalid",
  ])
    expect(codeHttpOriginAllowed(url, own)).toBe(false);
  expect(codeHttpOriginAllowed("https://external.example/a", own)).toBe(true);
  expect(codeHttpOriginAllowed("https://cloud.example.evil.example/a", own)).toBe(true);
  expect(codeHttpOriginAllowed("https://cloud.example:9443/a", own)).toBe(true);
});

test("an invalid installation origin fails closed", () => {
  expect(codeHttpOriginAllowed("https://external.example", ["invalid app.url"])).toBe(false);
});

test("A3a classifies target status without guessing from provider codes or broker statuses", () => {
  for (const status of [403, 404]) {
    for (const code of ["not_found", "forbidden", "unknown"]) expect(codeBridgeDispatchRefusalKind(code, status)).toBe("target_refused");
  }
  for (const status of [undefined, 400, 401, 409, 429, 500, 502]) expect(codeBridgeDispatchRefusalKind("not_found", status)).toBe("bridge");
  expect(codeBridgeDispatchRefusalKind("app_access_denied")).toBe("app_not_allowed");
  expect(codeBridgeDispatchRefusalKind("app_access_denied", 403)).toBe("app_not_allowed");
  expect(codeBridgeDispatchRefusalKind("mandate_forbidden")).toBe("policy");
  expect(codeBridgeDispatchRefusalKind("mandate_policy_denied")).toBe("policy");
  for (const code of ["code_policy_never", "code_unattended_forbidden", "code_disabled", "code_stream_forbidden", "code_access_forbidden"])
    expect(codeBridgeDispatchRefusalKind(code, 403)).toBe("policy");
  for (const code of ["capability_not_found", "invalid_app_response", "schema_mismatch"])
    for (const status of [403, 404]) expect(codeBridgeDispatchRefusalKind(code, status)).toBe("bridge");
});

test("A3a policy refusals never become target refusals", () => {
  for (const code of [
    "code_policy_never",
    "code_capability_undeclared",
    "code_ai_budget_limit",
    "code_ai_daily_budget_limit",
    "code_ai_owner_daily_budget_limit",
    "code_sends_not_yet",
    "code_unattended_forbidden",
    "code_http_origin_forbidden",
    "code_http_origin_undeclared",
    "code_http_path_forbidden",
    "code_http_secret_forbidden",
    "code_http_forbidden",
  ]) {
    expect(codeBridgeLocalRefusalKind(code)).toBe("policy");
    for (const status of [undefined, 403, 404]) expect(codeBridgeDispatchRefusalKind(code, status)).toBe("policy");
  }
  for (const code of ["code_bridge_unavailable", "code_rate_limited", "code_mandate_mismatch", "not_found"])
    expect(codeBridgeLocalRefusalKind(code)).toBe("bridge");
});

test("A3a distinguishes approval refusals from policy and target refusals", () => {
  for (const code of ["code_approval_required", "code_approval_revoked", "code_hash_mismatch"]) {
    expect(codeBridgeLocalRefusalKind(code)).toBe("approval");
    for (const status of [undefined, 403, 404]) expect(codeBridgeDispatchRefusalKind(code, status)).toBe("approval");
  }
});

test("an in-flight AI budget reservation is distinguishable from an exhausted policy budget", () => {
  expect(codeBridgeLocalRefusalKind("code_ai_budget_reserved")).toBe("bridge");
});

test("the signed bridge Skill read fixture compiles without integration infrastructure", () => {
  const compiled = compileCapabilities("core", { protocolVersion: 2, queries: { "ai.skill.read": bridgeSkillReadQuery } });
  expect(compiled.queries.has("ai.skill.read")).toBe(true);
});
