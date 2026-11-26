import { afterEach, expect, spyOn, test } from "bun:test";
import { notifications, trace } from "@k2b/cloud/services";
import * as workflowStore from "@k2b/cloud/workflows/store";
import { syncOpsService } from "../sync/runtime";
import { parseRunsAddress, runsQuery } from "./query";
import { listRuns, readJobTimeline, readRunFigures, readSuccessMinutes, searchWorkflowDefinitions, workflowFilterNames } from "./service";

const definition = "5b1e9a00-0000-4000-8000-000000000001";
const parent = "5b1e9a00-0000-4000-8000-000000000002";
const now = new Date("2026-11-26T08:00:00.000Z");
const spies: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("one workflow definition and one parent run reach the workflow store; the other kinds ask nothing", async () => {
  const runs = spyOn(workflowStore, "listWorkflowRuns").mockResolvedValue([]);
  const jobs = spyOn(trace, "list").mockResolvedValue({ spans: [], total: 0 });
  const deliveries = spyOn(notifications.observability.deliveries, "list").mockResolvedValue({ items: [], total: 0 } as never);
  const deadLetters = spyOn(syncOpsService, "overview").mockResolvedValue({ deadLetters: [], truncatedStores: [] } as never);
  spies.push(runs, jobs, deliveries, deadLetters);

  const { state } = parseRunsAddress(
    runsQuery("de", [{ id: "mail", label: "Mail" }]),
    new URLSearchParams(`workflow=${definition}&parent=${parent}&status=failed&app=mail`),
  );
  const parts = await listRuns(state, ["job", "workflow", "delivery", "deadLetter"], {
    page: 1,
    perPage: 100,
    preview: 20,
    credentials: {} as never,
    now,
  });

  expect(runs).toHaveBeenCalledTimes(1);
  expect(runs.mock.calls[0]![0]).toEqual({
    appId: "mail",
    states: ["failed", "needs_attention"],
    workflowId: definition,
    parentRunId: parent,
    since: new Date("2026-11-25T08:00:00.000Z"),
    limit: 21,
    offset: 0,
  });
  for (const spy of [jobs, deliveries, deadLetters]) expect(spy).not.toHaveBeenCalled();
  expect(parts.map((part) => [part.kind, part.rows.length, part.total])).toEqual([
    ["job", 0, 0],
    ["workflow", 0, null],
    ["delivery", 0, 0],
    ["deadLetter", 0, 0],
  ]);
});

test("the chosen definition and parent run are named with one read each, and nothing is read without them", async () => {
  const definitionRead = spyOn(workflowStore, "getWorkflow").mockResolvedValue({
    id: definition,
    name: "Rechnung ablegen",
    appId: "mail",
  } as never);
  const parentRead = spyOn(workflowStore, "getWorkflowRun").mockResolvedValue({
    id: parent,
    workflowName: "Monatsabschluss",
    appId: "mail",
  } as never);
  spies.push(definitionRead, parentRead);
  const query = runsQuery("de");
  const named = await workflowFilterNames(parseRunsAddress(query, new URLSearchParams(`workflow=${definition}&parent=${parent}`)).state);
  expect(named).toEqual({
    workflow: [{ value: definition, label: "Rechnung ablegen", meta: "mail" }],
    parent: [{ value: parent, label: "Monatsabschluss", meta: "mail" }],
  });
  expect([definitionRead.mock.calls.length, parentRead.mock.calls.length]).toEqual([1, 1]);
  expect(await workflowFilterNames(parseRunsAddress(query, new URLSearchParams("kind=job")).state)).toEqual({});
  expect([definitionRead.mock.calls.length, parentRead.mock.calls.length]).toEqual([1, 1]);
});

const STATS = {
  runs: 9,
  sources: 2,
  running: 1,
  stuck: 1,
  anomalous: 0,
  succeeded: 1,
  failed: 7,
  errorRate: 77.8,
  avgDurationMs: 900,
  p95DurationMs: 4_200,
  p99DurationMs: 9_000,
};
const MINUTES = { minutes: [], total: 0, count: 1_284, avgDurationMs: 300, maxDurationMs: 4_100, p95DurationMs: 3_200 };

test("key figures read only the kinds the view shows, with the view's window and filters; a failed store leaves its figures out", async () => {
  const stats = spyOn(trace, "stats").mockResolvedValue(STATS);
  const minutes = spyOn(trace, "successMinutes").mockResolvedValue(MINUTES);
  const summary = spyOn(notifications.observability.deliveries, "summary").mockResolvedValue({
    total: 1_502,
    active: 2,
    delivered: 1_468,
    suppressed: 29,
    failed: 3,
  });
  spies.push(stats, minutes, summary);
  const query = runsQuery("de", [{ id: "mail", label: "Mail" }]);
  const { state } = parseRunsAddress(query, new URLSearchParams("time=last-7d&app=mail"));

  expect(await readRunFigures(state, ["job", "delivery"], now)).toEqual({
    job: { succeeded: 1_284, failed: 7, running: 1, stuck: 1, p95DurationMs: 4_200 },
    delivery: { total: 1_502, active: 2, delivered: 1_468, suppressed: 29, failed: 3 },
  });
  expect(stats.mock.calls[0]![0]).toEqual({ filter: { window: "7d", appId: "mail" } });
  expect(summary.mock.calls[0]![0]).toEqual({
    days: 7,
    filter: { since: new Date("2026-11-19T08:00:00.000Z"), appIds: ["mail"] },
  });

  // workflow runs and dead letters have no figures here; nothing is read for them
  expect(await readRunFigures(state, ["workflow", "deadLetter"], now)).toEqual({});
  expect([stats.mock.calls.length, minutes.mock.calls.length, summary.mock.calls.length]).toEqual([1, 1, 1]);

  summary.mockRejectedValueOnce(new Error("down"));
  expect((await readRunFigures(state, ["delivery"], now)).delivery).toBeNull();
});

test("the job lanes read one bounded page of traces in the window; per minute keeps the job filters, not kind or status", async () => {
  const list = spyOn(trace, "list").mockResolvedValue({
    spans: [
      {
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        name: "Postfach abgleichen",
        source: "mail:imap-sync",
        status: "error",
        statusMessage: "Zeitüberschreitung",
        startedAt: "2026-11-26T07:30:00.000Z",
        endedAt: "2026-11-26T07:30:30.000Z",
        durationMs: 30_000,
      },
    ] as never,
    total: 3_000,
  });
  const minutes = spyOn(trace, "successMinutes").mockResolvedValue(MINUTES);
  spies.push(list, minutes);
  const query = runsQuery("de");

  const timeline = await readJobTimeline(parseRunsAddress(query, new URLSearchParams("kind=job&time=last-1h")).state, now);
  expect(list.mock.calls[0]).toEqual([{ page: 1, perPage: 2000, offset: 0 }, { filter: { window: "1h" } }]);
  expect(timeline).toMatchObject({ shown: 1, total: 3_000, fromMs: now.getTime() - 3_600_000, toMs: now.getTime() });
  expect(timeline.rows.map((row) => [row.source, row.intervals.map((interval) => interval.state)])).toEqual([
    ["mail:imap-sync", ["error"]],
  ]);

  await readSuccessMinutes(parseRunsAddress(query, new URLSearchParams("kind=delivery&status=failed&q=sync&page=2")).state, 2, 100);
  expect(minutes.mock.calls[0]).toEqual([{ page: 2, perPage: 100, offset: 100 }, { filter: { window: "24h", search: "sync" } }]);
});

test("waiting workflow runs include queued ones; the definition search asks the store by name before its limit", async () => {
  const runs = spyOn(workflowStore, "listWorkflowRuns").mockResolvedValue([]);
  const families = spyOn(workflowStore, "listWorkflowFamilies").mockResolvedValue([
    { workflowId: definition, workflowName: "Rechnung ablegen", appId: "mail" } as never,
  ]);
  spies.push(runs, families);
  const { state } = parseRunsAddress(runsQuery("de"), new URLSearchParams("status=waiting"));
  await listRuns(state, ["workflow"], { page: 1, perPage: 100, preview: 20, credentials: {} as never, now });
  expect(runs.mock.calls[0]![0]).toMatchObject({ states: ["queued", "waiting"] });

  const items = await searchWorkflowDefinitions("  Rechnung ", { appId: "mail", since: now, limit: 20 });
  expect(families.mock.calls[0]![0]).toEqual({ appId: "mail", search: "Rechnung", since: now, limit: 20 });
  expect(items).toEqual([{ value: definition, label: "Rechnung ablegen", meta: "mail" }]);
});
