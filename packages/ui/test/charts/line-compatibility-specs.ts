import type { LineOptions } from "../../src/charts/core/svg";

/** Legacy multi-series cases: gaps, isolated values, errors and line styles without new options. */
export const lineCompatibilitySpecs = [3, 5].map((count) => ({
  series: Array.from({ length: count }, (_, i) => ({
    label: `Source ${i + 1}`,
    data:
      i === 1
        ? [{ x: 2, y: 3 }]
        : [
            { x: 1, y: 2 + i, errY: 0.5 },
            { x: 2, y: Number.NaN },
            { x: 3, y: 5 + i, errY: 1 },
          ],
    lineStyle: i === 2 ? ("dashed" as const) : ("solid" as const),
  })),
  width: 480,
  height: 280,
  legend: true,
  inspect: true,
})) satisfies LineOptions[];
