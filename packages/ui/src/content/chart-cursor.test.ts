import { expect, test } from "bun:test";
import { createChartCursor } from "./chart-cursor";

test("cursor isolates groups, rejects invalid X and ignores stale source cleanup", () => {
  const cursor = createChartCursor(),
    other = createChartCursor();
  const a = Symbol(),
    b = Symbol();
  const values: (number | null)[] = [];
  const unsubscribe = cursor.subscribe((state) => values.push(state?.x ?? null));
  cursor.move(a, 10);
  cursor.move(a, 10);
  cursor.move(b, 20);
  cursor.clear(a);
  cursor.move(b, NaN);
  expect(cursor.read()?.x).toBe(20);
  expect(other.read()).toBeNull();
  cursor.clear(b);
  unsubscribe();
  cursor.move(a, 30);
  expect(values).toEqual([null, 10, 20, null]);
});
