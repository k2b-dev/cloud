import { expect, test } from "bun:test";
import { CODE_SECRET_ERRORS } from "@k2b/cloud/ai/browser";
import type { CapabilityInvocation } from "@k2b/cloud/capabilities";
import type { CodeQueryInvoke } from "./code-summary";
import { loadSecretTitles, secretTitleRef } from "./secret-titles";

const block = (args: unknown, result: unknown) => ({ kind: "tool", name: "code_secret", args, result });
const target = { name: "API", origin: "https://api.example.com", target: { code: "Abc234", pathPrefix: "/v1" } };

test("only a stored lost-right line of an automation names one", () => {
  expect(secretTitleRef(block(target, { failed: true, error: CODE_SECRET_ERRORS.accessLost }))).toBe("Abc234");
  expect(secretTitleRef(block(target, { failed: true, error: CODE_SECRET_ERRORS.signInExpired }))).toBeNull();
  expect(secretTitleRef(block(target, { configured: true, name: "API" }))).toBeNull();
  expect(secretTitleRef(block({ name: "API" }, { failed: true, error: CODE_SECRET_ERRORS.accessLost }))).toBeNull();
  expect(secretTitleRef({ ...block(target, { failed: true, error: CODE_SECRET_ERRORS.accessLost }), name: "code_run" })).toBeNull();
});

test("titles come from code.read with the reader's rights, once per automation; only Core's no makes a missing title", async () => {
  const calls: CapabilityInvocation[] = [];
  const answers: Record<string, unknown> = {
    Abc234: { ok: true, data: { data: { code: { title: "Paketstatus abrufen" } } } },
    Gone11: { ok: false, error: { code: "NOT_FOUND", status: 404 } },
    Hidden: { ok: false, error: { code: "FORBIDDEN", status: 403 } },
    Busy11: { ok: false, error: { code: "UNAVAILABLE", status: 503 } },
  };
  const invoke = (async (invocation: CapabilityInvocation) => {
    calls.push(invocation);
    const codeId = (invocation.input as { codeId: string }).codeId;
    if (codeId === "Throws") throw new Error("transport");
    return answers[codeId];
  }) as CodeQueryInvoke;
  expect(await loadSecretTitles(invoke, ["Abc234", "Gone11", "Abc234", "Hidden", "Busy11", "Throws"])).toEqual({
    Abc234: "Paketstatus abrufen",
    Gone11: null,
    Hidden: null,
  });
  expect(calls.map((call) => [call.capabilityId, (call.input as { codeId: string }).codeId])).toEqual([
    ["code.read", "Abc234"],
    ["code.read", "Gone11"],
    ["code.read", "Hidden"],
    ["code.read", "Busy11"],
    ["code.read", "Throws"],
  ]);
  expect(await loadSecretTitles(invoke, [])).toEqual({});
});
