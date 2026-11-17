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
