import { expect, spyOn, test } from "bun:test";
import type { AiTurnSnapshot } from "@k2b/cloud/ai";
import { codeVersionCardsContract } from "@k2b/cloud/contracts/code-version-cards";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import type { CodeQueryInvoke } from "./code-summary";
import { chatCodeVersionRefs, loadCodeVersionCards } from "./code-version-cards";

const codeId = "c_info01",
  versionId = "66666666-6666-4666-8666-666666666666";

test("schema failures leave a visible read failure and a diagnostic without payloads or error messages", async () => {
  const diagnostic = spyOn(console, "warn").mockImplementation(() => {});
  const secret = "private-response-content";
  try {
    const invoke: CodeQueryInvoke = async () => {
      z.literal("expected").parse(secret);
      throw new Error("unreachable");
    };
    expect(await loadCodeVersionCards(invoke, [{ codeId, versionId }])).toEqual([{ codeId, versionId, state: "failed" }]);
    expect(diagnostic).toHaveBeenCalledWith("Code version cards could not be loaded", {
      reason: "invalid_data",
      issueCodes: ["invalid_value"],
    });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(codeId);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(versionId);
  } finally {
    diagnostic.mockRestore();
  }
});

test("transport, provider, missing results and stalled continuations report bounded reasons without private details", async () => {
  const diagnostic = spyOn(console, "warn").mockImplementation(() => {});
  const secret = "private-response-content";
  const cases: Array<{ reason: string; invoke: CodeQueryInvoke }> = [
    {
      reason: "request_failed",
      invoke: async () => {
        throw new Error(secret);
      },
    },
    {
      reason: "invalid_json",
      invoke: async () => {
        throw new SyntaxError(secret);
      },
    },
    {
      reason: "invalid_response",
      invoke: async () => ({ ok: false, error: { code: "INVALID_APP_RESPONSE", message: secret, status: 502 } }),
    },
    { reason: "unavailable", invoke: async () => ({ ok: false, error: { code: "APP_UNAVAILABLE", message: secret, status: 503 } }) },
    {
      reason: "read_failed",
      invoke: async (_call, schema) => ok({ data: schema.parse({ items: [{ codeId, versionId, state: "failed" }] }) }),
    },
    { reason: "missing_result", invoke: async (_call, schema) => ok({ data: schema.parse({ items: [] }) }) },
    {
      reason: "continuation_stalled",
      invoke: async (_call, schema) => ok({ data: schema.parse({ items: [], remaining: [{ codeId, versionId }] }) }),
    },
  ];
  try {
    for (const entry of cases) {
      diagnostic.mockClear();
      expect(await loadCodeVersionCards(entry.invoke, [{ codeId, versionId }])).toEqual([{ codeId, versionId, state: "failed" }]);
      expect(diagnostic).toHaveBeenCalledTimes(1);
      expect(diagnostic.mock.calls[0]?.[1]).toMatchObject({ reason: entry.reason });
      if (entry.reason === "invalid_response")
        expect(diagnostic.mock.calls[0]?.[1]).toMatchObject({ status: 502, code: "INVALID_APP_RESPONSE" });
      if (entry.reason === "unavailable") expect(diagnostic.mock.calls[0]?.[1]).toMatchObject({ status: 503, code: "APP_UNAVAILABLE" });
      const logged = JSON.stringify(diagnostic.mock.calls);
      for (const privateValue of [secret, codeId, versionId]) expect(logged).not.toContain(privateValue);
    }
  } finally {
    diagnostic.mockRestore();
  }
});
test("the receipt window bounds a batch and rejects untrusted references before transport", () => {
  expect(codeVersionCardsContract.input.safeParse({ versions: Array(50).fill({ codeId, versionId }) }).success).toBe(true);
  expect(codeVersionCardsContract.input.safeParse({ versions: Array(51).fill({ codeId, versionId }) }).success).toBe(false);
  expect(chatCodeVersionRefs([], null)).toEqual([]);
});
test("one loader deduplicates displayed versions and preserves denial versus read failure", async () => {
  const calls: unknown[] = [];
  const invoke: CodeQueryInvoke = async (invocation, schema) => {
    calls.push(invocation);
    return ok({ data: schema.parse({ items: [{ codeId, versionId, state: "denied" }] }) });
  };
  expect(
    await loadCodeVersionCards(invoke, [
      { codeId, versionId },
      { codeId, versionId },
    ]),
  ).toEqual([{ codeId, versionId, state: "denied" }]);
  expect(calls).toHaveLength(1);
  const failing: CodeQueryInvoke = async () => {
    throw new Error("unavailable");
  };
  expect(await loadCodeVersionCards(failing, [{ codeId, versionId }])).toEqual([{ codeId, versionId, state: "failed" }]);
});

test("the SSR loader selects the displayed successful version from a live turn and rejects malformed receipts", () => {
  const nextId = "77777777-7777-4777-8777-777777777777";
  const submitted = (id: string, number: number): AiTurnSnapshot["blocks"][number] => ({
    id,
    kind: "tool",
    callId: id,
    name: "code_submit",
    status: "completed",
    args: { codeId },
    result: { submission: { version: { id, number } } },
  });
  const active: AiTurnSnapshot = {
    turnId: "turn",
    attempt: 1,
    status: "running",
    seq: 3,
    modelId: null,
    createdAt: "2026-11-17T08:00:00.000Z",
    blocks: [submitted(versionId, 1), submitted(nextId, 2), submitted("invalid", 3)],
  };
  expect(chatCodeVersionRefs([], active)).toEqual([{ codeId, versionId: nextId }]);
});

test("the loader follows only remaining refs with a fresh invocation and preserves display order", async () => {
  const second = { codeId, versionId: "77777777-7777-4777-8777-777777777777" };
  const first = { codeId, versionId };
  const calls: unknown[] = [];
  const invoke: CodeQueryInvoke = async (invocation, schema) => {
    calls.push(invocation.input);
    return ok({
      data: schema.parse(
        calls.length === 1
          ? { items: [{ ...second, state: "denied" }], remaining: [first] }
          : { items: [{ ...first, state: "denied" }], remaining: [] },
      ),
    });
  };
  expect(await loadCodeVersionCards(invoke, [first, second], [versionId, second.versionId])).toEqual([
    { ...first, state: "denied" },
    { ...second, state: "denied" },
  ]);
  expect(calls).toEqual([
    { versions: [first, second], knownPages: [versionId, second.versionId] },
    { versions: [first], knownPages: [versionId] },
  ]);
});

test("an unavailable or non-progressing continuation is retryable, never denied or repeated forever", async () => {
  const refs = [
    { codeId, versionId },
    { codeId, versionId: "77777777-7777-4777-8777-777777777777" },
  ];
  for (const noProgress of [false, true]) {
    let calls = 0;
    const invoke: CodeQueryInvoke = async (_invocation, schema) => {
      calls++;
      if (noProgress) return ok({ data: schema.parse({ items: [], remaining: refs }) });
      if (calls === 1) return ok({ data: schema.parse({ items: [{ ...refs[0], state: "denied" }], remaining: [refs[1]] }) });
      throw new Error("owner provider unavailable");
    };
    const items = await loadCodeVersionCards(invoke, refs);
    expect(items.map((item) => item.state)).toEqual(noProgress ? ["failed", "failed"] : ["denied", "failed"]);
    expect(calls).toBe(noProgress ? 1 : 2);
  }
});
