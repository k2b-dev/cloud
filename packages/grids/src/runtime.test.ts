import { afterEach, expect, type Mock, spyOn, test } from "bun:test";
import { processQuiesce } from "@k2b/cloud/services/runtime-quiesce";
import { gridsRuntime } from "./runtime";
import * as boundedQuery from "./service/bounded-query";
import * as destruction from "./service/controlled-destruction";
import * as evidence from "./service/evidence-exports";
import * as fieldIndex from "./service/field-index-maintenance";
import * as querySettings from "./service/query-settings";
import * as outbox from "./service/record-event-outbox";
import * as retention from "./service/record-external-identity";
import * as workflows from "./service/workflow-runtime";

const spies: Mock<(...args: never[]) => unknown>[] = [];
const stub = <T extends object>(module: T, name: keyof T & string) => {
  const spy = spyOn(module, name as never).mockImplementation((async () => undefined) as never);
  spies.push(spy as never);
  return spy;
};

afterEach(async () => {
  await processQuiesce.resume();
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("maintenance quiesce stops the background work of Grids but keeps the read-query pool that serves requests", async () => {
  stub(querySettings, "getQuerySettings");
  for (const [module, names] of [
    [destruction, ["startControlledDestructionJobs", "stopControlledDestructionJobs"]],
    [evidence, ["startEvidenceExportJobs", "stopEvidenceExportJobs"]],
    [fieldIndex, ["startFieldIndexMaintenance", "stopFieldIndexMaintenance"]],
    [outbox, ["startRecordEventOutbox", "stopRecordEventOutbox"]],
    [retention, ["startExternalRecordOperationRetention", "stopExternalRecordOperationRetention"]],
  ] as const)
    for (const name of names) stub(module as Record<string, unknown>, name);
  const stopWorkflows = stub(workflows, "stopWorkflowRuntime");
  stub(workflows, "startWorkflowRuntime");
  const stopPool = stub(boundedQuery, "stopBoundedQueryPool");

  await gridsRuntime.start();
  expect(await processQuiesce.quiesce()).toEqual([]);
  expect(stopWorkflows).toHaveBeenCalledTimes(1);
  expect(stopPool).not.toHaveBeenCalled();
  expect(await processQuiesce.resume()).toEqual([]);

  await gridsRuntime.stop();
  expect(stopWorkflows).toHaveBeenCalledTimes(2);
  expect(stopPool).toHaveBeenCalledTimes(1);
});
