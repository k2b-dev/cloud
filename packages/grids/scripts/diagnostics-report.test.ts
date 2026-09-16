import { expect, test } from "bun:test";
import { summarize } from "./diagnostics-report";

test("summary uses the median rather than hiding a slow outlier in an average", () => {
  expect(summarize([1000, 2, 4, 3, 1])).toEqual({ median: 3, min: 1, max: 1000 });
  expect(summarize([2, 1])).toEqual({ median: 1.5, min: 1, max: 2 });
});

test("invalid timings cannot become plausible-looking report numbers", () => {
  for (const values of [[], [NaN], [-1], [Infinity]]) expect(() => summarize(values)).toThrow("Invalid timing samples");
});
