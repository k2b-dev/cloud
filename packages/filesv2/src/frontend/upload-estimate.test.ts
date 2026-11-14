import { expect, test } from "bun:test";
import { createUploadEstimate } from "./upload-estimate";

test("uses remaining bytes, not file count, after a short warm-up", () => {
  const eta = createUploadEstimate();
  eta.start(0);
  expect(eta.progress(0, 10000, 100)).toBeNull();
  expect(eta.progress(1000, 9000, 1100)).toBeNull();
  expect(eta.progress(3000, 7000, 3100)).toBe(8);
});

test("accumulates small files while excluding resumed receipts", () => {
  const eta = createUploadEstimate();
  for (let file = 0; file < 4; file++) {
    eta.start(file * 1000);
    eta.progress(900_000, 100_000, file * 1000 + 10);
    const seconds = eta.progress(900_100, 100_000, file * 1000 + 900);
    if (file === 3) expect(seconds).toBeGreaterThan(800);
  }
});

test("smooths an isolated slowdown and resets after a wait or new batch", () => {
  const eta = createUploadEstimate();
  eta.start(0);
  eta.progress(0, 100_000, 0);
  const before = eta.progress(10_000, 100_000, 10_000)!;
  const after = eta.progress(10_100, 100_000, 11_000)!;
  expect(after).toBeGreaterThanOrEqual(before);
  expect(after).toBeLessThan(before * 1.1);
  eta.reset();
  eta.start(20_000);
  expect(eta.progress(10_100, 100_000, 20_010)).toBeNull();
  expect(eta.progress(10_200, 100_000, 21_010)).toBeNull();
});
