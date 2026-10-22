import type { ActivityEntry } from "../activity-contracts";

/** An activity ID addresses one Files record; correlation IDs never become source-run URLs. */
export const executionUrl = (activityId: string) => `/app/filesv2/execution/${encodeURIComponent(activityId)}`;

/** The reader includes execution context only on a fully authorized projection. */
export const historyExecutionHref = (entry: ActivityEntry) => (entry.execution ? executionUrl(entry.id) : null);
