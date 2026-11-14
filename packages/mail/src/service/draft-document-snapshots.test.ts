import { afterEach, expect, jest, setSystemTime, spyOn, test } from "bun:test";
import { draftDocumentSnapshots, flushDraftDocumentSnapshot, markDraftDocumentDirty } from "./draft-document-snapshots";

const queued = spyOn(draftDocumentSnapshots, "queue").mockResolvedValue();
const flushed = spyOn(draftDocumentSnapshots, "flushNow").mockResolvedValue(null);
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  setSystemTime();
  queued.mockClear();
  flushed.mockClear();
});
const clock = () => {
  setSystemTime(new Date("2026-11-12T12:00:00Z"));
  jest.useFakeTimers();
};
test("snapshot debounce resets on typing and queues only the newest acknowledged cursor", async () => {
  clock();
  markDraftDocumentDirty({ docId: "quiet", targetCursor: "s6t.test.1" });
  jest.advanceTimersByTime(2000);
  markDraftDocumentDirty({ docId: "quiet", targetCursor: "s6t.test.2" });
  jest.advanceTimersByTime(2999);
  expect(queued).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(queued).toHaveBeenCalledWith({ docId: "quiet", targetCursor: "s6t.test.2", reason: "debounce" });
});
test("continuous typing cannot defer the first snapshot beyond thirty seconds", async () => {
  clock();
  for (let i = 0; i < 15; i++) {
    markDraftDocumentDirty({ docId: "continuous", targetCursor: `s6t.test.${i}` });
    jest.advanceTimersByTime(2000);
  }
  expect(queued).toHaveBeenCalledTimes(1);
  expect(queued).toHaveBeenCalledWith({ docId: "continuous", targetCursor: "s6t.test.14", reason: "debounce" });
});
test("an explicit flush clears debounce work before reading the accepted log head", async () => {
  clock();
  markDraftDocumentDirty({ docId: "leaving", targetCursor: "s6t.test.1" });
  await flushDraftDocumentSnapshot("leaving");
  jest.advanceTimersByTime(30_000);
  expect(queued).not.toHaveBeenCalled();
  expect(flushed).toHaveBeenCalledTimes(1);
});
