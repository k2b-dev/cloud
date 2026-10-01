/*
 * One upload batch: every file picked or dropped until the batch is closed, in the order it was added. The total
 * is byte-weighted, so one large video moves the bar as much as its share of the data. Transitions mutate the
 * batch in place, so a Solid store can apply them through `produce` and only touched rows re-render.
 */

export type UploadStatus = "pending" | "working" | "success" | "failed" | "skipped" | "cancelled";
export type UploadPhase = "running" | "done" | "errors" | "cancelled";

export type UploadRow = {
  id: number;
  /** Path below the upload target, as it was picked or dropped. */
  path: string;
  name: string;
  size: number;
  /** Bytes the current attempt has transferred. */
  sent: number;
  status: UploadStatus;
  /** The last failure. It stays while a retry waits or runs, so cancelling the retry returns the file to it. */
  reason: string | null;
  group: number;
};

export type UploadBatch = {
  rows: UploadRow[];
  phase: UploadPhase;
  /** Where every file goes, or null once files for different folders joined the batch. */
  target: { key: string; label: string } | null;
  /** Counted rows: everything except skipped files, which were never meant to transfer. */
  count: number;
  totalBytes: number;
  done: number;
  doneBytes: number;
  failed: number;
  failedBytes: number;
  skipped: number;
  active: number | null;
  /** How many rows share a file name; a shared name shows its folder. Without a prototype, so any name is a plain key. */
  names: Record<string, number>;
  /** Row ids in upload order; entries before `head` have had their turn. Retries join at the end. */
  queue: number[];
  head: number;
  /** The last 25 % step announced. */
  milestone: number;
};

export type UploadAnnouncement =
  | { kind: "started"; count: number }
  | { kind: "appended"; added: number; count: number }
  | { kind: "progress"; percent: number; done: number; count: number }
  | { kind: "failed"; name: string; reason: string }
  | { kind: "retrying"; count: number; name: string }
  | { kind: "finished"; done: number; count: number; failed: number; skipped: number }
  | { kind: "cancelled"; done: number; count: number };

export const createBatch = (): UploadBatch => ({
  rows: [],
  phase: "running",
  target: null,
  count: 0,
  totalBytes: 0,
  done: 0,
  doneBytes: 0,
  failed: 0,
  failedBytes: 0,
  skipped: 0,
  active: null,
  names: Object.create(null) as Record<string, number>,
  queue: [],
  head: 0,
  milestone: 0,
});

const MILESTONES = [75, 50, 25];
const baseName = (path: string) => path.split("/").at(-1) ?? path;

/** Whole percent of the batch. It reaches 100 only when every counted file is uploaded. */
export const percent = (batch: UploadBatch): number => {
  if (!batch.count) return 0;
  if (batch.done === batch.count) return 100;
  return Math.min(99, Math.floor(doneFraction(batch) * 100));
};

/** Fractions of the bar: uploaded bytes and failed bytes, each of the batch total. Empty files count as one file each. */
export const doneFraction = (batch: UploadBatch): number => {
  if (!batch.count) return 0;
  const active = batch.active === null ? null : batch.rows[batch.active]!;
  if (!batch.totalBytes) return (batch.done + (active ? active.sent / Math.max(1, active.size) : 0)) / batch.count;
  return Math.min(1, (batch.doneBytes + (active ? Math.min(active.sent, active.size) : 0)) / batch.totalBytes);
};
export const failedFraction = (batch: UploadBatch): number =>
  !batch.count ? 0 : batch.totalBytes ? batch.failedBytes / batch.totalBytes : batch.failed / batch.count;

/** The folder prefix appears only when two files in the batch share a name. */
export const showsFolder = (batch: UploadBatch, row: UploadRow): boolean => (batch.names[row.name] ?? 0) > 1 && row.path.includes("/");

/** A new step resets to the one already passed, so a batch that grows does not announce a step twice or skip one. */
const resetMilestone = (batch: UploadBatch) => {
  batch.milestone = Math.floor(percent(batch) / 25) * 25;
};

const milestone = (batch: UploadBatch): UploadAnnouncement | null => {
  const value = percent(batch);
  // The summary announces the end; a step passed on the way there would only delay it.
  if (value === 100) batch.milestone = 100;
  const reached = MILESTONES.find((step) => value >= step && step > batch.milestone);
  if (reached === undefined || batch.phase !== "running") return null;
  batch.milestone = reached;
  return { kind: "progress", percent: reached, done: batch.done, count: batch.count };
};

/** Adds files to the batch. After the batch finished, the same batch runs again with the new files at the end. */
export const appendFiles = (
  batch: UploadBatch,
  target: { key: string; label: string },
  group: number,
  files: readonly { path: string; size: number }[],
): UploadAnnouncement | null => {
  if (!files.length) return null;
  const fresh = batch.rows.length === 0;
  if (fresh) batch.target = target;
  else if (batch.target && batch.target.key !== target.key) batch.target = null;
  for (const file of files) {
    const id = batch.rows.length;
    const name = baseName(file.path);
    batch.rows.push({ id, path: file.path, name, size: file.size, sent: 0, status: "pending", reason: null, group });
    batch.names[name] = (batch.names[name] ?? 0) + 1;
    batch.queue.push(id);
    batch.count++;
    batch.totalBytes += file.size;
  }
  batch.phase = "running";
  resetMilestone(batch);
  return fresh ? { kind: "started", count: batch.count } : { kind: "appended", added: files.length, count: batch.count };
};

/** The next waiting row, or null when the queue is drained. Rows failed or cancelled meanwhile are passed over. */
export const nextRow = (batch: UploadBatch): number | null => {
  for (let index = batch.head; index < batch.queue.length; index++) {
    const id = batch.queue[index]!;
    if (batch.rows[id]!.status === "pending") return id;
  }
  return null;
};

export const startRow = (batch: UploadBatch, id: number) => {
  while (batch.head < batch.queue.length && batch.queue[batch.head] !== id) batch.head++;
  batch.head++;
  const row = batch.rows[id]!;
  row.status = "working";
  row.sent = 0;
  batch.active = id;
};

export const reportProgress = (batch: UploadBatch, id: number, bytes: number): UploadAnnouncement | null => {
  const row = batch.rows[id]!;
  if (row.status !== "working") return null;
  row.sent = Math.max(0, Math.min(row.size, bytes));
  return milestone(batch);
};

export const finishRow = (
  batch: UploadBatch,
  id: number,
  outcome: { status: "success" } | { status: "skipped" } | { status: "failed"; reason: string },
): UploadAnnouncement | null => {
  const row = batch.rows[id]!;
  if (row.status !== "working") return null;
  if (batch.active === id) batch.active = null;
  row.status = outcome.status;
  if (outcome.status !== "failed") row.reason = null;
  if (outcome.status === "success") {
    row.sent = row.size;
    batch.done++;
    batch.doneBytes += row.size;
    return milestone(batch);
  }
  row.sent = 0;
  if (outcome.status === "skipped") {
    batch.skipped++;
    batch.count--;
    batch.totalBytes -= row.size;
    return milestone(batch);
  }
  row.reason = outcome.reason;
  batch.failed++;
  batch.failedBytes += row.size;
  return { kind: "failed", name: row.name, reason: outcome.reason };
};

/** Fails every waiting row of one group, as when its folders could not be created. */
export const failGroup = (batch: UploadBatch, group: number, reason: string) => {
  for (let index = batch.head; index < batch.queue.length; index++) {
    const row = batch.rows[batch.queue[index]!]!;
    if (row.group !== group || row.status !== "pending") continue;
    row.status = "failed";
    row.reason = reason;
    batch.failed++;
    batch.failedBytes += row.size;
  }
};

/** Puts failed rows back in line, all of them when no ids are given. Each keeps its reason until it gets a new result. */
export const retryRows = (batch: UploadBatch, ids?: readonly number[]): UploadAnnouncement | null => {
  const rows = (ids ? ids.map((id) => batch.rows[id]!) : batch.rows).filter((row) => row.status === "failed");
  if (!rows.length) return null;
  for (const row of rows) {
    row.status = "pending";
    row.sent = 0;
    batch.failed--;
    batch.failedBytes -= row.size;
    batch.queue.push(row.id);
  }
  batch.phase = "running";
  resetMilestone(batch);
  return { kind: "retrying", count: rows.length, name: rows[0]!.name };
};

/**
 * Stops the batch: finished files stay finished, everything still waiting or uploading is cancelled. A file that was
 * being retried returns to its failure, so a cancel never takes away the way to try it again.
 */
export const cancelBatch = (batch: UploadBatch): UploadAnnouncement | null => {
  if (batch.phase !== "running") return null;
  for (const row of batch.rows) {
    if (row.status !== "pending" && row.status !== "working") continue;
    row.sent = 0;
    if (row.reason === null) {
      row.status = "cancelled";
      continue;
    }
    row.status = "failed";
    batch.failed++;
    batch.failedBytes += row.size;
  }
  batch.active = null;
  batch.head = batch.queue.length;
  batch.phase = "cancelled";
  return { kind: "cancelled", done: batch.done, count: batch.count };
};

/**
 * Ends a drained batch: quiet success, or the errors state that stays until it is closed. A batch that was cancelled
 * stays cancelled after a retry, since its cancelled files were never uploaded.
 */
export const settleBatch = (batch: UploadBatch): UploadAnnouncement | null => {
  if (!batch.rows.length || batch.phase !== "running" || batch.active !== null || nextRow(batch) !== null) return null;
  if (batch.rows.some((row) => row.status === "cancelled")) {
    batch.phase = "cancelled";
    return { kind: "cancelled", done: batch.done, count: batch.count };
  }
  batch.phase = batch.failed ? "errors" : "done";
  return { kind: "finished", done: batch.done, count: batch.count, failed: batch.failed, skipped: batch.skipped };
};
