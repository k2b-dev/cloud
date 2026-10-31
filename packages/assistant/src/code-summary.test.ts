import { expect, test } from "bun:test";
import type { z } from "zod";
import {
  type CodeQueryInvoke,
  type CodeRunSummary,
  type CodeSummary,
  codeStatus,
  hasPersonalCode,
  loadCodeSummaries,
} from "./code-summary";

const code = (id: string, state = "active") => ({
  id,
  owner: { kind: "resource", ref: { type: "mail.mailbox", id: "m_info" } },
  title: `Code ${id}`,
  serviceAccountId: "44444444-4444-4444-8444-444444444444",
  state,
  activeVersionId: null,
  createdBy: null,
  createdAt: "2026-10-28T08:00:00.000Z",
  permission: "reader",
});
const run = (state: string) => ({
  id: "55555555-5555-4555-8555-555555555555",
  codeId: "c_info01",
  versionId: "66666666-6666-4666-8666-666666666666",
  trigger: "schedule",
  entrypoint: "sort",
  state,
  outcome: null,
  createdAt: "2026-10-31T09:41:00.000Z",
  startedAt: "2026-10-31T09:41:01.000Z",
  endedAt: "2026-10-31T09:41:03.000Z",
});

/** Core's answers by capability, parsed through the caller's own schema like the real transport. */
const fakeCore = (answers: Record<string, (input: { codeId?: string }) => unknown>) => {
  const calls: Array<{ capabilityId: string; input: unknown }> = [];
  const invoke: CodeQueryInvoke = async <T extends z.ZodType>(
    invocation: { appId: string; capabilityId: string; input: unknown },
    schema: T,
  ) => {
    calls.push({ capabilityId: invocation.capabilityId, input: invocation.input });
    expect(invocation.appId).toBe("core");
    const answer = answers[invocation.capabilityId]?.(invocation.input as { codeId?: string });
    if (answer === undefined) return { ok: false as const, error: { code: "NOT_FOUND", message: "missing", status: 404 } };
    return { ok: true as const, data: { data: schema.parse(answer) } };
  };
  return { invoke, calls };
};

test("asks Core for one personal Code item to decide whether the entry shows", async () => {
  const empty = fakeCore({ "code.list": () => ({ items: [], nextCursor: null }) });
  expect(await hasPersonalCode(empty.invoke, "11111111-1111-4111-8111-111111111111")).toBe(false);
  expect(empty.calls).toEqual([
    { capabilityId: "code.list", input: { owner: { kind: "person", userId: "11111111-1111-4111-8111-111111111111" }, limit: 1 } },
  ]);
  const some = fakeCore({ "code.list": () => ({ items: [code("c_week01")], nextCursor: "c_week01" }) });
  expect(await hasPersonalCode(some.invoke, "11111111-1111-4111-8111-111111111111")).toBe(true);
  await expect(hasPersonalCode(fakeCore({}).invoke, "11111111-1111-4111-8111-111111111111")).rejects.toThrow("missing");
});

test("lists one owner's Code with its newest run; a missing run history keeps the Code", async () => {
  const core = fakeCore({
    "code.list": () => ({ items: [code("c_info01"), code("c_info02", "paused")], nextCursor: "c_info02" }),
    "code.run.list": (input) => (input.codeId === "c_info01" ? { items: [run("failed")], nextCursor: null } : undefined),
  });
  const page = await loadCodeSummaries(core.invoke, { kind: "resource", ref: { type: "mail.mailbox", id: "m_info" } });
  expect(page.more).toBe(true);
  expect(page.items.map((item) => [item.id, item.state, item.lastRun?.state ?? null])).toEqual([
    ["c_info01", "active", "failed"],
    ["c_info02", "paused", null],
  ]);
  expect(core.calls[0]).toEqual({
    capabilityId: "code.list",
    input: { owner: { kind: "resource", ref: { type: "mail.mailbox", id: "m_info" } }, limit: 20 },
  });
  expect(core.calls.slice(1).map((call) => call.input)).toEqual([
    { codeId: "c_info01", limit: 1 },
    { codeId: "c_info02", limit: 1 },
  ]);
});

test("a failed list is an error, not an empty list", async () => {
  await expect(loadCodeSummaries(fakeCore({}).invoke, { kind: "person", userId: "11111111-1111-4111-8111-111111111111" })).rejects.toThrow(
    "missing",
  );
});

test("one status per Code: paused and a failed last run come before on", () => {
  const summary = (state: CodeSummary["state"], last: CodeRunSummary["state"] | null): CodeSummary => ({
    id: "c_a1b2",
    title: "A",
    state,
    lastRun: last ? { state: last, createdAt: "2026-10-31T09:41:00.000Z", endedAt: null } : null,
  });
  expect(codeStatus(summary("active", null))).toEqual({ key: "on", tone: "success" });
  expect(codeStatus(summary("active", "succeeded"))).toEqual({ key: "on", tone: "success" });
  expect(codeStatus(summary("active", "failed"))).toEqual({ key: "failed", tone: "danger" });
  expect(codeStatus(summary("paused", "failed"))).toEqual({ key: "paused", tone: "warning" });
  expect(codeStatus(summary("draft", null))).toEqual({ key: "draft", tone: "neutral" });
  expect(codeStatus(summary("deleting", null))).toEqual({ key: "deleting", tone: "neutral" });
});
