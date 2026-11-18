import { expect, test } from "bun:test";
import type { AiTurnSnapshot } from "@k2b/cloud/ai";
import { codeVersionCardsContract } from "@k2b/cloud/contracts/code-version-cards";
import { ok } from "@k2b/stdlib";
import type { CodeQueryInvoke } from "./code-summary";
import { chatCodeVersionRefs, loadCodeVersionCards } from "./code-version-cards";

const codeId = "c_info01",
  versionId = "66666666-6666-4666-8666-666666666666";
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
