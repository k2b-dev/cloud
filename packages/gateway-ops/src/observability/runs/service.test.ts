import { afterEach, expect, spyOn, test } from "bun:test";
import { notifications, trace } from "@k2b/cloud/services";
import * as workflowStore from "@k2b/cloud/workflows/store";
import { syncOpsService } from "../sync/runtime";
import { parseRunsAddress, runsQuery } from "./query";
import { listRuns, workflowFilterNames } from "./service";

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
    state: "failed",
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
