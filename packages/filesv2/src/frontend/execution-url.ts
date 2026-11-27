import type { ActivityEntry } from "../activity-contracts";
import type { ActivityFilters } from "./history-requests";
import { activityUrl } from "./urls";
import type { RunSnapshot } from "./workspace-state";

/** An ordinary HTTP request is not a delegated run. The reader strips these fields from limited projections. */
export const hasRun = (execution: ActivityEntry["execution"]) =>
  !!execution && !!(execution.invocationId || execution.origin || execution.callingApp);

/** A run opens beside Activity's list under these filters; an activity ID addresses one Files record. */
export const runHref = (filters: ActivityFilters) => (entry: ActivityEntry) =>
  hasRun(entry.execution) ? activityUrl(filters, entry.id) : null;

/** What a read entry shows as a run: a formerly full entry may now have only a projection without its run. */
export const runOf = (id: string, entry: ActivityEntry): RunSnapshot =>
  hasRun(entry.execution) ? { id, entry } : { id, problem: "missing" };
