import { expect, test } from "bun:test";
import { compare, summary } from "./statistics";

test("p95 uses nearest rank without dropping outliers or sorting the input", () => {
  const samples = Array.from({ length: 20 }, (_, i) => 20 - i);
  expect(summary(samples)).toEqual({ samples: 20, meanMs: 10.5, p50Ms: 10, p95Ms: 19, p99Ms: 20 });
  expect(samples[0]).toBe(20);
});

test("small baselines accept exactly 10ms, not more", () => {
  expect(compare([2], [12]).passes).toBe(true);
  expect(compare([2], [12.001]).passes).toBe(false);
});

test("larger baselines accept exactly 10 percent, not more", () => {
  expect(compare([200], [220]).passes).toBe(true);
  expect(compare([200], [220.001]).passes).toBe(false);
  expect(compare([200], [100]).passes).toBe(true);
});

test("insufficient or invalid measurements cannot pass", () => {
  expect(() => compare([], [])).toThrow();
  expect(() => compare([1], [1, 2])).toThrow();
  for (const invalid of [NaN, Infinity, -1]) expect(() => compare([1], [invalid])).toThrow();
});
