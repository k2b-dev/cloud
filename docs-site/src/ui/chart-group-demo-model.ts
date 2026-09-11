export type LinkedChartRow = {
  key: string;
  seriesKey: string;
  series: string;
  payload: number;
  current: number | null;
  reference: number | null;
};

export function comparisonValues(current: number | null, reference: number | null) {
  if (current === null || reference === null) return { delta: null, percent: null };
  const delta = current - reference;
  return { delta, percent: reference === 0 ? null : (delta / Math.abs(reference)) * 100 };
}
export const signed = (value: number) => `${value > 0 ? "+" : ""}${Math.round(value * 10) / 10}`;
