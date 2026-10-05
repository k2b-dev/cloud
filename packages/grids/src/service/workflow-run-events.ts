import { logger } from "@k2b/cloud/services";
import { sql } from "bun";
import { toPublicWorkflowError, toPublicWorkflowSteps } from "../api/workflow-run-projection";
import {
  type GridsWorkflowRunEvent,
  toWorkflowRunEventSummary,
  toWorkflowRunStepSummary,
  type WorkflowRunEventScope,
} from "../lib/workflow-run-events";
import type { GridsWorkflowRun, GridsWorkflowStepRun } from "../workflows/contracts";
import { gridsLive, gridsLiveKey } from "./live";
import { projectPublicIds } from "./public-resources";
import { projectWorkflowCaptureSteps } from "./workflow-query-store";

const log = logger("grids:workflow-run-events");

/** The run update as pages read it: public IDs, public errors, and public step outcomes. */
export const toPublicWorkflowRunEvent = async (
  event: GridsWorkflowRunEvent,
  projectIds = projectPublicIds,
  loadCaptureSteps = projectWorkflowCaptureSteps,
) => {
  const workflowInternalIds = [event.workflowId, event.run.workflowId].filter((id): id is string => Boolean(id));
  const launcherInternalIds = event.run.launcherId ? [event.run.launcherId] : [];
  const [bases, workflows, runs, launchers] = await Promise.all([
    projectIds("base", [event.baseId, event.run.baseId]),
    projectIds("workflow", workflowInternalIds),
    projectIds("workflowRun", [event.run.id]),
    projectIds("workflowLauncher", launcherInternalIds),
  ]);
  const required = (ids: ReadonlyMap<string, string>, id: string, resource: string) => {
    const publicId = ids.get(id);
    if (!publicId) throw new Error(`Missing public ID for ${resource}`);
    return publicId;
  };
  const runId = required(runs, event.run.id, "workflow run");
  return {
    ...event,
    baseId: required(bases, event.baseId, "base"),
    workflowId: event.workflowId ? required(workflows, event.workflowId, "workflow") : null,
    run: {
      ...event.run,
      error: toPublicWorkflowError(event.run.error),
      id: runId,
      baseId: required(bases, event.run.baseId, "base"),
      workflowId: event.run.workflowId ? required(workflows, event.run.workflowId, "workflow") : null,
      launcherId: event.run.launcherId ? required(launchers, event.run.launcherId, "workflow launcher") : null,
    },
    steps: (await toPublicWorkflowSteps({ items: event.steps, truncated: false }, runId, projectIds, loadCaptureSteps)).items,
  };
};

/**
 * Writes a run transition, with the steps it changed, for the pages that
 * follow the run's workflow. The workflow kernel reports a transition after it
 * committed it, so the update is written right after that commit, in a
 * transaction of its own. Updates above 32 KiB reach pages as a reload of the
 * run. A failure is logged and never fails the run.
 */
export const publishWorkflowRunEvent = async (
  run: GridsWorkflowRun,
  steps: GridsWorkflowStepRun[] = [],
  scope: WorkflowRunEventScope = { kind: "workflow" },
): Promise<void> => {
  const workflowId = run.workflowId;
  if (!workflowId) return;
  try {
    const data = await toPublicWorkflowRunEvent({
      v: 1,
      baseId: run.baseId,
      workflowId,
      run: toWorkflowRunEventSummary(run),
      scope,
      steps: steps.map(toWorkflowRunStepSummary),
    });
    await gridsLive.publish(sql, { key: gridsLiveKey.workflow(workflowId), data });
    gridsLive.wake();
  } catch (error) {
    log.warn("Workflow run update was not written", {
      workflowId,
      runId: run.id,
      status: run.status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
