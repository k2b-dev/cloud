import { expect, test } from "bun:test";
import type { CodeActivityReadModel } from "@k2b/cloud/contracts/code-read-model";
import type { CodeQueryInvoke } from "../code-summary";
import { automationTiming, type CodeOverviewItem, cardStatus, dayLine, loadCodeCardExtras, localDay } from "./code-overview";

const DAY = { from: "2026-11-13T23:00:00.000Z", to: "2026-11-14T23:00:00.000Z" };
const activity = (marks: CodeActivityReadModel["timeline"]["marks"]): CodeActivityReadModel => ({
  week: "2026-11-09T00:00:00.000Z",
  counters: { items: [], more: 0, moreText: null },
  recent: [],
  timeline: { ...DAY, marks, total: marks.length },
});
const item = (id: string, patch: Partial<CodeOverviewItem> = {}): CodeOverviewItem => ({
  id,
  title: id,
  state: "active",
  lastRun: null,
  ...patch,
});
const run = (state: "succeeded" | "failed" | "running" | "queued", id = "11111111-1111-4111-8111-111111111111") => ({
  id,
  state,
  createdAt: "2026-11-14T05:30:00.000Z",
  startedAt: "2026-11-14T05:30:00.000Z",
  endedAt: null,
});

test("the day line puts every Code's marks in time order and counts them as the sentence says", () => {
  const line = dayLine([
    item("c_aaaa", {
      extras: {
        runs: [],
        failure: null,
        activity: activity([
          { at: "2026-11-14T11:00:00.000Z", state: "succeeded", count: 1, runId: "11111111-1111-4111-8111-111111111111" },
          { at: "2026-11-14T20:00:00.000Z", state: "planned", count: 1 },
        ]),
      },
    }),
    item("c_bbbb", {
      extras: {
        runs: [],
        failure: null,
        activity: activity([
          { at: "2026-11-14T05:00:00.000Z", state: "failed", count: 1, runId: "22222222-2222-4222-8222-222222222222" },
          { at: "2026-11-14T12:00:00.000Z", state: "queued", count: 1, runId: "33333333-3333-4333-8333-333333333333" },
          { at: "2026-11-14T12:30:00.000Z", state: "skipped", count: 1, runId: "44444444-4444-4444-8444-444444444444" },
        ]),
      },
    }),
  ]);
  expect(line?.marks.map((mark) => [mark.state, mark.codeId])).toEqual([
    ["failed", "c_bbbb"],
    ["succeeded", "c_aaaa"],
    ["running", "c_bbbb"],
    ["skipped", "c_bbbb"],
    ["planned", "c_aaaa"],
  ]);
  expect(line).toMatchObject({ succeeded: 1, failed: 1, planned: 1, running: 1, grouped: 0 });
  // 06:00 local is a quarter of the day.
  expect(line?.marks[0]?.at).toBeCloseTo(0.25, 5);
});

test("above 200 marks the line groups equal portions of the day and keeps the counts", () => {
  const marks = Array.from({ length: 150 }, (_, index) => ({
    at: new Date(Date.parse(DAY.from) + index * 60_000).toISOString(),
    state: "succeeded" as const,
    count: 1,
    runId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  }));
  const extras = { runs: [], failure: null, activity: activity(marks) };
  const line = dayLine([item("c_aaaa", { extras }), item("c_bbbb", { extras })]);
  expect(line!.marks.length).toBeLessThanOrEqual(200);
  expect(line!.marks.every((mark) => mark.state === "group" && mark.runId === null)).toBe(true);
  expect(line!.marks.reduce((total, mark) => total + mark.count, 0)).toBe(300);
  expect(line!.succeeded).toBe(300);
  expect(dayLine([item("c_aaaa")])).toBeNull();
});

test("a card whose day did not load leaves the totals marked as partial, never complete-looking", () => {
  const ok = { runs: [], failure: null, activity: activity([{ at: DAY.from, state: "succeeded", count: 2 }]) };
  const failed = { runs: [], failure: null, activity: null };
  const line = dayLine([item("c_aaaa", { extras: ok }), item("c_bbbb", { extras: failed })]);
  expect(line).toMatchObject({ succeeded: 2, missing: 1 });
  expect(dayLine([item("c_aaaa", { extras: ok })])).toMatchObject({ missing: 0 });
});

test("a card says running, failed, missing access or paused before on", () => {
  expect(cardStatus(item("c_a", { state: "paused" }))).toBe("paused");
  expect(cardStatus(item("c_a", { extras: { runs: [run("queued")], activity: null, failure: null } }))).toBe("running");
  expect(cardStatus(item("c_a", { extras: { runs: [run("failed")], activity: null, failure: null } }))).toBe("failed");
  expect(cardStatus(item("c_a", { removedTargets: [{ type: "spaces.space", id: "s", title: null, typeTitle: "Space" }] }))).toBe(
    "access_missing",
  );
  expect(cardStatus(item("c_a", { lastRun: { state: "succeeded", createdAt: DAY.from, endedAt: DAY.from } }))).toBe("on");
});

test("an automation's timing is a sentence and never the schedule expression", () => {
  const schedule = (cron: string) => ({ kind: "schedule" as const, cron });
  expect(automationTiming(schedule("0 7 * * 1"), "de")).toBe("Montags um 07:00");
  expect(automationTiming(schedule("30 6 * * *"), "de")).toBe("Täglich um 06:30");
  expect(automationTiming(schedule("0 7 * * 1"), "en")).toBe("Mondays at 07:00");
  expect(automationTiming(schedule("*/5 3 * * 1-5"), "de")).toBe("Nach Zeitplan");
  expect(automationTiming({ kind: "event", cron: null }, "de")).toBe("Bei einem Ereignis");
  expect(automationTiming({ kind: "manual", cron: null }, "en")).toBe("Started by hand");
});

test("a card reads its runs and day, and asks why only after a failed run", async () => {
  const calls: string[] = [];
  const invoke = (async (invocation, schema) => {
    calls.push(invocation.capabilityId);
    const data =
      invocation.capabilityId === "code.run.list"
        ? { items: [run("failed")] }
        : invocation.capabilityId === "code.activity.words"
          ? activity([])
          : {
              runId: "11111111-1111-4111-8111-111111111111",
              title: "Lauf",
              state: "failed",
              status: "Fehlgeschlagen",
              at: DAY.from,
              reason: "Preisliste nicht erreichbar",
              untilThen: { items: [], more: 0, moreText: null },
              complete: true,
            };
    return { ok: true, data: { data: schema.parse(data) } };
  }) as CodeQueryInvoke;
  const extras = await loadCodeCardExtras(invoke, "c_aaaa", { day: "2026-11-14", timeZone: "Europe/Berlin" });
  expect(extras.failure).toBe("Preisliste nicht erreichbar");
  expect(calls.sort()).toEqual(["code.activity.words", "code.run.list", "code.run.words"]);
  // A refused read leaves only that part out.
  const refused = (async (invocation, schema) =>
    invocation.capabilityId === "code.activity.words"
      ? { ok: false, error: { code: "FORBIDDEN", message: "no" } }
      : { ok: true, data: { data: schema.parse({ items: [] }) } }) as CodeQueryInvoke;
  expect(await loadCodeCardExtras(refused, "c_aaaa", { day: "2026-11-14", timeZone: "UTC" })).toEqual({
    runs: [],
    activity: null,
    failure: null,
  });
});

test("the person's day is their local date", () => {
  expect(localDay("Europe/Berlin", new Date("2026-11-14T23:30:00.000Z"))).toBe("2026-11-15");
  expect(localDay("America/New_York", new Date("2026-11-14T03:00:00.000Z"))).toBe("2026-11-13");
});
