import type { ActivityEntry } from "../activity-contracts";

/** An activity ID addresses one Files record; correlation IDs never become source-run URLs. */
export const executionUrl = (activityId: string) => `/app/filesv2/execution/${encodeURIComponent(activityId)}`;

/** An ordinary HTTP request is not a delegated run. The reader strips these fields from limited projections. */
export const hasRun = (execution: ActivityEntry["execution"]) =>
  !!execution && !!(execution.invocationId || execution.origin || execution.callingApp);

export const historyExecutionHref = (entry: ActivityEntry) => (hasRun(entry.execution) ? executionUrl(entry.id) : null);
