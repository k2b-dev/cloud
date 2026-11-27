import { expect, test } from "bun:test";
import { withoutAttachment } from "./attachment-figures";

const now = "2026-11-20T10:00:00.000Z";
const figures = () => ({ days: [0, 0, 2, 0, 1], count: 9, bytes: 10_000, added: 3 });

test("a file uploaded today leaves today's count, the uploads, the files and their bytes", () => {
  expect(withoutAttachment(figures(), { sizeBytes: 1_500, createdAt: "2026-11-20T08:00:00.000Z" }, now, "UTC")).toEqual({
    days: [0, 0, 2, 0, 0],
    count: 8,
    bytes: 8_500,
    added: 2,
  });
});

test("the day is the reader's: 23:30 UTC on the 17th is already the 18th in Berlin", () => {
  const gone = withoutAttachment(figures(), { sizeBytes: 100, createdAt: "2026-11-17T23:30:00.000Z" }, now, "Europe/Berlin");
  expect(gone.days).toEqual([0, 0, 1, 0, 1]);
  expect(gone.added).toBe(2);
});

test("a file older than the window changes only the files and their bytes", () => {
  expect(withoutAttachment(figures(), { sizeBytes: 20_000, createdAt: "2026-09-01T08:00:00.000Z" }, now, "UTC")).toEqual({
    days: [0, 0, 2, 0, 1],
    count: 8,
    bytes: 0,
    added: 3,
  });
});
