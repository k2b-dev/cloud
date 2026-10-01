import { describe, expect, test } from "bun:test";
import {
  appendFiles,
  cancelBatch,
  createBatch,
  doneFraction,
  failedFraction,
  failGroup,
  finishRow,
  nextRow,
  percent,
  reportProgress,
  retryRows,
  settleBatch,
  showsFolder,
  startRow,
  type UploadAnnouncement,
  type UploadBatch,
} from "./upload-batch";

const target = { key: "home:Projects", label: "Projects" };
const MB = 1024 * 1024;
const files = (...entries: [string, number][]) => entries.map(([path, size]) => ({ path, size }));

/** Runs the next row to completion and collects what it announced. */
const complete = (batch: UploadBatch, outcome: Parameters<typeof finishRow>[2] = { status: "success" }) => {
  const id = nextRow(batch)!;
  startRow(batch, id);
  return finishRow(batch, id, outcome);
};

describe("upload batch totals", () => {
  test("weigh files by bytes, so a large file in flight dominates the percent", () => {
    const batch = createBatch();
    appendFiles(batch, target, 0, files(["a.pdf", 1 * MB], ["b.pdf", 1 * MB], ["video.mp4", 98 * MB]));
    complete(batch);
    complete(batch);
    expect(batch.done).toBe(2);
    expect(percent(batch)).toBe(2);
    const video = nextRow(batch)!;
    startRow(batch, video);
    reportProgress(batch, video, 49 * MB);
    expect(percent(batch)).toBe(51);
    expect(doneFraction(batch)).toBeCloseTo(0.51);
  });

  test("reach 100 % only when every file is uploaded", () => {
    const batch = createBatch();
    appendFiles(batch, target, 0, files(["big.iso", 1000 * MB], ["tiny.txt", 1]));
    const big = nextRow(batch)!;
    startRow(batch, big);
    reportProgress(batch, big, 1000 * MB);
    finishRow(batch, big, { status: "success" });
    expect(percent(batch)).toBe(99);
    complete(batch, { status: "failed", reason: "Connection lost" });
    expect(percent(batch)).toBe(99);
    expect(settleBatch(batch)).toEqual({ kind: "finished", done: 1, count: 2, failed: 1, skipped: 0 });
    retryRows(batch);
    complete(batch);
    expect(percent(batch)).toBe(100);
  });

  test("count empty files by number, since they have no bytes", () => {
    const batch = createBatch();
    appendFiles(batch, target, 0, files(["a.txt", 0], ["b.txt", 0], ["c.txt", 0], ["d.txt", 0]));
    complete(batch);
    expect(percent(batch)).toBe(25);
    expect(doneFraction(batch)).toBe(0.25);
  });

  test("leave skipped files out of the totals", () => {
    const batch = createBatch();
    appendFiles(batch, target, 0, files(["exists.pdf", 10 * MB], ["new.pdf", 10 * MB]));
    complete(batch, { status: "skipped" });
    expect({ count: batch.count, totalBytes: batch.totalBytes, skipped: batch.skipped }).toEqual({
      count: 1,
      totalBytes: 10 * MB,
      skipped: 1,
    });
    complete(batch);
    expect(percent(batch)).toBe(100);
    expect(settleBatch(batch)).toEqual({ kind: "finished", done: 1, count: 1, failed: 0, skipped: 1 });
    expect(batch.phase).toBe("done");
  });

  test("show failed bytes as their own share of the bar", () => {
    const batch = createBatch();
    appendFiles(batch, target, 0, files(["a.jpg", 30], ["b.jpg", 10], ["c.jpg", 60]));
    complete(batch);
    complete(batch, { status: "failed", reason: "Server did not answer" });
    expect(doneFraction(batch)).toBe(0.3);
    expect(failedFraction(batch)).toBe(0.1);
  });
});

describe("upload batch transitions", () => {
  test("append files while running: they queue behind the waiting ones and the totals grow", () => {
    const batch = createBatch();
    expect(appendFiles(batch, target, 0, files(["a.pdf", 50], ["b.pdf", 50]))).toEqual({ kind: "started", count: 2 });
    complete(batch);
    expect(percent(batch)).toBe(50);
    expect(appendFiles(batch, target, 1, files(["Scans/c.pdf", 100]))).toEqual({ kind: "appended", added: 1, count: 3 });
    expect(percent(batch)).toBe(25);
    expect(batch.rows.map((row) => row.path)).toEqual(["a.pdf", "b.pdf", "Scans/c.pdf"]);
    expect(nextRow(batch)).toBe(1);
    complete(batch);
    expect(nextRow(batch)).toBe(2);
    expect(batch.target).toEqual(target);
  });

  test("files for another folder keep the batch but drop the shared target", () => {
    const batch = createBatch();
    appendFiles(batch, target, 0, files(["a.pdf", 1]));
    appendFiles(batch, { key: "home:Archive", label: "Archive" }, 1, files(["b.pdf", 1]));
    expect(batch.target).toBeNull();
  });

  test("files added after the batch finished run in the same batch again", () => {
    const batch = createBatch();
    appendFiles(batch, target, 0, files(["a.pdf", 1]));
    complete(batch);
    settleBatch(batch);
    expect(batch.phase).toBe("done");
    appendFiles(batch, target, 1, files(["b.pdf", 1]));
    expect(batch.phase).toBe("running");
    expect(nextRow(batch)).toBe(1);
  });

  test("failure keeps the reason, retry puts the file back at the end and clears it", () => {
    const batch = createBatch();
    appendFiles(batch, target, 0, files(["a.jpg", 10], ["b.jpg", 10], ["c.jpg", 10]));
    expect(complete(batch, { status: "failed", reason: "Connection lost" })).toEqual({
      kind: "failed",
      name: "a.jpg",
      reason: "Connection lost",
    });
    expect(batch.rows[0]).toMatchObject({ status: "failed", reason: "Connection lost", sent: 0 });
    expect(retryRows(batch, [0])).toEqual({ kind: "retrying", count: 1, name: "a.jpg" });
    expect(batch.rows[0]).toMatchObject({ status: "pending", reason: null });
    expect(batch.failed).toBe(0);
    expect(batch.failedBytes).toBe(0);
    expect(nextRow(batch)).toBe(1);
    complete(batch);
    complete(batch);
    expect(nextRow(batch)).toBe(0);
  });

  test("retry after the batch ended runs it again; retrying nothing changes nothing", () => {
    const batch = createBatch();
    appendFiles(batch, target, 0, files(["a.jpg", 10], ["b.jpg", 10]));
    complete(batch, { status: "failed", reason: "x" });
    complete(batch, { status: "failed", reason: "y" });
    settleBatch(batch);
    expect(batch.phase).toBe("errors");
    expect(retryRows(batch, [])).toBeNull();
    expect(retryRows(batch)).toEqual({ kind: "retrying", count: 2, name: "a.jpg" });
    expect(batch.phase).toBe("running");
    expect(settleBatch(batch)).toBeNull();
  });

  test("a group whose folders could not be created fails its waiting files only", () => {
    const batch = createBatch();
    appendFiles(batch, target, 0, files(["Photos/a.jpg", 10], ["Photos/b.jpg", 10]));
    appendFiles(batch, target, 1, files(["c.jpg", 10]));
    const first = nextRow(batch)!;
    startRow(batch, first);
    finishRow(batch, first, { status: "failed", reason: "No permission" });
    failGroup(batch, 0, "No permission");
    expect(batch.rows.map((row) => row.status)).toEqual(["failed", "failed", "pending"]);
    expect(batch.failed).toBe(2);
    expect(nextRow(batch)).toBe(2);
  });

  test("cancel keeps finished files and marks the rest cancelled", () => {
    const batch = createBatch();
    appendFiles(batch, target, 0, files(["a", 1], ["b", 1], ["c", 1], ["d", 1]));
    complete(batch);
    complete(batch, { status: "failed", reason: "x" });
    startRow(batch, nextRow(batch)!);
    expect(cancelBatch(batch)).toEqual({ kind: "cancelled", done: 1, count: 4 });
    expect(batch.rows.map((row) => row.status)).toEqual(["success", "failed", "cancelled", "cancelled"]);
    expect(batch.active).toBeNull();
    expect(nextRow(batch)).toBeNull();
    expect(cancelBatch(batch)).toBeNull();
    // A late result of the aborted upload does not revive its row.
    expect(finishRow(batch, 2, { status: "success" })).toBeNull();
    expect(batch.rows[2]!.status).toBe("cancelled");
  });
});

describe("upload batch presentation rules", () => {
  test("a folder prefix appears only for names that occur twice in the batch", () => {
    const batch = createBatch();
    appendFiles(batch, target, 0, files(["Photos/IMG_1.jpg", 1], ["Scans/page.pdf", 1], ["notes.md", 1]));
    expect(batch.rows.map((row) => showsFolder(batch, row))).toEqual([false, false, false]);
    appendFiles(batch, target, 1, files(["Backup/IMG_1.jpg", 1], ["IMG_1.jpg", 1]));
    expect(batch.rows.map((row) => showsFolder(batch, row))).toEqual([true, false, false, true, false]);
  });

  test("milestones announce 25, 50 and 75 % once each, never single percent steps", () => {
    const batch = createBatch();
    appendFiles(batch, target, 0, files(["big.bin", 100]));
    const id = nextRow(batch)!;
    startRow(batch, id);
    const said: UploadAnnouncement[] = [];
    for (let bytes = 1; bytes <= 100; bytes++) {
      const announcement = reportProgress(batch, id, bytes);
      if (announcement) said.push(announcement);
    }
    expect(said).toEqual([
      { kind: "progress", percent: 25, done: 0, count: 1 },
      { kind: "progress", percent: 50, done: 0, count: 1 },
      { kind: "progress", percent: 75, done: 0, count: 1 },
    ]);
  });

  test("a jump across several steps announces only the highest, and growth does not repeat a step", () => {
    const batch = createBatch();
    appendFiles(batch, target, 0, files(["a", 60], ["b", 40]));
    expect(complete(batch)).toEqual({ kind: "progress", percent: 50, done: 1, count: 2 });
    appendFiles(batch, target, 1, files(["c", 100]));
    expect(percent(batch)).toBe(30);
    expect(complete(batch)).toEqual({ kind: "progress", percent: 50, done: 2, count: 3 });
    expect(complete(batch)).toBeNull();
  });
});
