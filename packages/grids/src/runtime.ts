import { createRuntimeLifecycle, stopRuntimeResources } from "@k2b/cloud/services";
import { stopBoundedQueryPool } from "./service/bounded-query";
import { startControlledDestructionJobs, stopControlledDestructionJobs } from "./service/controlled-destruction";
import { startEvidenceExportJobs, stopEvidenceExportJobs } from "./service/evidence-exports";
import { startFieldIndexMaintenance, stopFieldIndexMaintenance } from "./service/field-index-maintenance";
import { getQuerySettings } from "./service/query-settings";
import { startRecordEventOutbox, stopRecordEventOutbox } from "./service/record-event-outbox";
import { startExternalRecordOperationRetention, stopExternalRecordOperationRetention } from "./service/record-external-identity";
import { startWorkflowRuntime, stopWorkflowRuntime } from "./service/workflow-runtime";

/** Background work only: maintenance quiesce stops and starts it while requests keep being answered. */
const background = createRuntimeLifecycle({
  start: async () => {
    await getQuerySettings();
    await startControlledDestructionJobs();
    await startEvidenceExportJobs();
    await startExternalRecordOperationRetention();
    await startWorkflowRuntime();
    await startRecordEventOutbox();
    startFieldIndexMaintenance();
  },
  stop: () =>
    stopRuntimeResources([
      stopFieldIndexMaintenance,
      stopRecordEventOutbox,
      stopWorkflowRuntime,
      stopExternalRecordOperationRetention,
      stopControlledDestructionJobs,
      stopEvidenceExportJobs,
    ]),
});

/** The Grids process runtime: its background work, and at process stop also the read-query pool that serves requests. */
export const gridsRuntime = {
  start: background.start,
  stop: () => stopRuntimeResources([background.stop, stopBoundedQueryPool]),
};
