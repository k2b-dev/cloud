import { logger } from "@k2b/cloud/services";

const log = logger("mail:sync");

/** What asked for a folder sync. A coalesced job keeps only its first input, so the count is taken on request. */
export type FolderSyncTrigger =
  | "scheduled"
  | "push"
  | "reconcile"
  | "command"
  | "maintenance"
  | "mailbox"
  | "continuation"
  | "busy"
  | "rate_limited";

/** How a folder batch ended: it committed a change, found the folder unchanged, waited, or failed. */
export type FolderBatchOutcome = "committed" | "unchanged" | "deferred" | "failed";

const REPORT_INTERVAL_MS = 10 * 60_000;

let triggers: Partial<Record<FolderSyncTrigger, number>> = {};
let batches: Partial<Record<FolderBatchOutcome, number>> = {};
let reportTimer: ReturnType<typeof setInterval> | null = null;

export const countFolderSyncTrigger = (trigger: FolderSyncTrigger, folders = 1): void => {
  triggers[trigger] = (triggers[trigger] ?? 0) + folders;
};

export const countFolderBatch = (outcome: FolderBatchOutcome): void => {
  batches[outcome] = (batches[outcome] ?? 0) + 1;
};

/** The counts since the last call; the process report and tests read them. */
export const takeFolderSyncActivity = (): {
  triggers: Partial<Record<FolderSyncTrigger, number>>;
  batches: Partial<Record<FolderBatchOutcome, number>>;
} => {
  const taken = { triggers, batches };
  triggers = {};
  batches = {};
  return taken;
};

/** Logs this process's folder sync requests and batch outcomes every ten minutes in which any happened. */
export const startFolderSyncActivityReport = (): void => {
  if (reportTimer) return;
  reportTimer = setInterval(() => {
    const activity = takeFolderSyncActivity();
    if (Object.keys(activity.triggers).length === 0 && Object.keys(activity.batches).length === 0) return;
    log.info("Mail folder sync activity", { windowMinutes: REPORT_INTERVAL_MS / 60_000, ...activity });
  }, REPORT_INTERVAL_MS);
  reportTimer.unref?.();
};

export const stopFolderSyncActivityReport = (): void => {
  if (reportTimer) clearInterval(reportTimer);
  reportTimer = null;
};
