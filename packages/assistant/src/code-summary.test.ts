import { expect, test } from "bun:test";
import type { z } from "zod";
import {
  type CodeQueryInvoke,
  type CodeRunSummary,
  type CodeSummary,
  automationStatus,
  codeStatus,
  countOwnRunsSince,
  hasPersonalCode,
  loadCodeAttention,
  loadCodeSummaries,
  nextCodeRun,
  startOfDayIn,
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
const fakeCore = (answers: Record<string, (input: { codeId?: string; cursor?: string }) => unknown>) => {
  const calls: Array<{ capabilityId: string; input: unknown }> = [];
  const invoke: CodeQueryInvoke = async <T extends z.ZodType>(
    invocation: { appId: string; capabilityId: string; input: unknown },
    schema: T,
  ) => {
    calls.push({ capabilityId: invocation.capabilityId, input: invocation.input });
    expect(invocation.appId).toBe("core");
    const answer = answers[invocation.capabilityId]?.(invocation.input as { codeId?: string; cursor?: string });
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
  expect(page.nextCursor).toBe("c_info02");
  expect(page.items.map((item) => [item.id, item.state, item.lastRun === undefined ? "unknown" : (item.lastRun?.state ?? null)])).toEqual([
    ["c_info01", "active", "failed"],
    // Core could not read this run history: unknown, not "never ran".
    ["c_info02", "paused", "unknown"],
  ]);
  expect(core.calls[0]).toEqual({
    capabilityId: "code.list",
    input: { owner: { kind: "resource", ref: { type: "mail.mailbox", id: "m_info" } }, limit: 20 },
  });
  expect(core.calls.slice(1).map((call) => [call.capabilityId, call.input])).toEqual([
    ["code.run.list", { codeId: "c_info01", limit: 1 }],
    ["code.automation.list", { codeId: "c_info01" }],
    ["code.run.list", { codeId: "c_info02", limit: 1 }],
    ["code.automation.list", { codeId: "c_info02" }],
  ]);
  // Core could not list the automations: the Code stays one row, the list itself is unaffected.
  expect(page.items[0]!.automations).toBeUndefined();
});

test("a Code carries its automations, removed access and earliest next run", async () => {
  const automation = (entrypoint: string, nextRunAt: string | null, missing = false) => ({
    entrypoint,
    kind: "schedule",
    cron: "0 7 * * 1",
    nextRunAt,
    lastRun: null,
    missingTargets: missing ? [{ type: "spaces.space", id: "sp_2lg8", title: "Logistik", typeTitle: "Space" }] : [],
  });
  const core = fakeCore({
    "code.list": () => ({ items: [code("c_info01")], nextCursor: null }),
    "code.run.list": () => ({ items: [], nextCursor: null }),
    "code.automation.list": () => ({
      codeId: "c_info01",
      items: [automation("sort", "2026-11-03T06:00:00.000Z"), automation("deliveries", "2026-11-02T06:00:00.000Z", true)],
      removedTargets: [{ type: "spaces.space", id: "sp_2lg8", title: "Logistik", typeTitle: "Space" }],
    }),
  });
  const [item] = (await loadCodeSummaries(core.invoke, { kind: "resource", ref: { type: "mail.mailbox", id: "m_info" } })).items;
  expect(item!.automations!.map((entry) => entry.entrypoint)).toEqual(["sort", "deliveries"]);
  expect(nextCodeRun(item!)).toBe("2026-11-02T06:00:00.000Z");
  expect(codeStatus(item!)).toEqual({ key: "access_missing", tone: "warning" });
  // Only the automation that needs the access lacks it; the other keeps running.
  expect(automationStatus(item!, item!.automations![0]!)).toEqual({ key: "on", tone: "success" });
  expect(automationStatus(item!, item!.automations![1]!)).toEqual({ key: "access_missing", tone: "warning" });
  // Only the whole Code pauses.
  expect(automationStatus({ ...item!, state: "paused" }, item!.automations![1]!)).toEqual({ key: "paused", tone: "warning" });
});

test("a transport that throws for the automations does not fail the list", async () => {
  const core = fakeCore({
    "code.list": () => ({ items: [code("c_info01")], nextCursor: null }),
    "code.run.list": () => ({ items: [], nextCursor: null }),
    "code.automation.list": () => {
      throw new Error("Core is unavailable");
    },
  });
  const { items } = await loadCodeSummaries(core.invoke, { kind: "person", userId: "11111111-1111-4111-8111-111111111111" });
  expect(items.map((item) => item.automations)).toEqual([undefined]);
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

test("today starts at the person's local midnight, also across a time-zone change", () => {
  expect(startOfDayIn("Europe/Berlin", new Date("2026-10-24T10:00:00.000Z"))).toBe("2026-10-23T22:00:00.000Z");
  expect(startOfDayIn("Europe/Berlin", new Date("2026-11-01T10:00:00.000Z"))).toBe("2026-10-31T23:00:00.000Z");
  // 25 October: the day began in summer time, before the clocks went back at 03:00.
  expect(startOfDayIn("Europe/Berlin", new Date("2026-10-25T10:00:00.000Z"))).toBe("2026-10-24T22:00:00.000Z");
  expect(startOfDayIn("UTC", new Date("2026-11-01T00:30:00.000Z"))).toBe("2026-11-01T00:00:00.000Z");
  expect(startOfDayIn("America/New_York", new Date("2026-11-01T03:00:00.000Z"))).toBe("2026-10-31T04:00:00.000Z");
  // Havana turns its clocks back at 01:00 to 00:00 on 1 November, so midnight happens twice; the day starts at the first.
  expect(startOfDayIn("America/Havana", new Date("2026-11-01T12:00:00.000Z"))).toBe("2026-11-01T04:00:00.000Z");
  // Where 00:00 is skipped, the day starts at its first existing minute.
  expect(startOfDayIn("America/Santiago", new Date("2026-09-06T12:00:00.000Z"))).toBe("2026-09-06T04:00:00.000Z");
});

test("attention and run counts come from Core's public queries", async () => {
  const core = fakeCore({
    "code.attention.list": (input: { cursor?: string }) =>
      input.cursor === "c_page01"
        ? {
            items: [
              {
                code: { ...code("c_info02"), owner: { kind: "resource", ref: { type: "mail.mailbox", id: "m_info" } } },
                reasons: ["run_failed", "access_missing"],
                lastRunAt: "2026-10-31T09:41:03.000Z",
              },
            ],
            nextCursor: null,
          }
        : // A first window without the person's Code still continues.
          { items: [], nextCursor: "c_page01" },
    "code.run.count": () => ({ runs: 9, failed: 1 }),
  });
  expect(await loadCodeAttention(core.invoke)).toEqual({
    items: [
      {
        codeId: "c_info02",
        title: "Code c_info02",
        owner: { kind: "resource", ref: { type: "mail.mailbox", id: "m_info" } },
        reasons: ["run_failed", "access_missing"],
        lastRunAt: "2026-10-31T09:41:03.000Z",
      },
    ],
    nextCursor: null,
  });
  expect(await countOwnRunsSince(core.invoke, "2026-10-30T23:00:00.000Z")).toEqual({ runs: 9, failed: 1 });
  expect(core.calls.at(-1)).toEqual({ capabilityId: "code.run.count", input: { since: "2026-10-30T23:00:00.000Z" } });
  await expect(loadCodeAttention(fakeCore({}).invoke)).rejects.toThrow("missing");
});

test("attention stops after its bounded windows and says where to continue", async () => {
  let calls = 0;
  const endless = fakeCore({
    "code.attention.list": () => {
      calls++;
      return { items: [], nextCursor: `c_more0${calls}` };
    },
  });
  expect(await loadCodeAttention(endless.invoke)).toEqual({ items: [], nextCursor: "c_more04" });
  expect(calls).toBe(4);
});
