import type { ActivityEntry } from "../activity-contracts";
import { apiError } from "../api/api-error";
import { runOf } from "./execution-url";
import type { RunSnapshot } from "./workspace-state";

/**
 * Reads the run beside Activity's list on the server, with the reader's current rights. A refusal (4xx) and an entry
 * that no run made both say "missing", so neither tells which; a failure (5xx) offers to read it again. No stored
 * data and no error detail of a refused entry reaches the page.
 */
export const readRun = (id: string, read: () => Promise<ActivityEntry>): Promise<RunSnapshot> =>
  read().then(
    (entry) => runOf(id, entry),
    (error: unknown): RunSnapshot => ({ id, problem: apiError(error).status < 500 ? "missing" : "failed" }),
  );
