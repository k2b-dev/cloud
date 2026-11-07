import type { LineOptions } from "./svg";

/** Validate forecast bounds against the first series, sorted by X. Missing Y values retain their bound position. */
export const lineForecastLayout = (opts: LineOptions) => {
  if (!opts.forecast) return [];
  const { from, band } = opts.forecast;
  const points = [...(opts.series[0]?.data ?? [])].filter((p) => Number.isFinite(p.x)).sort((a, b) => a.x - b.x);
  if (!Number.isFinite(from) || (opts.xAxis?.scale === "log" && from <= 0) || !points.some((p) => p.x === from))
    throw new RangeError("Forecast must start at an X value of the first series");
  const suffix = points.filter((p) => p.x >= from);
  if (band && band.length !== suffix.length) throw new RangeError("Forecast band must match the ordered first series suffix");
  return suffix.map((p, index) => {
    const bounds = band?.[index];
    if (
      bounds &&
      (bounds.length !== 2 || !bounds.every(Number.isFinite) || bounds[0] > bounds[1] || (opts.yAxis?.scale === "log" && bounds[0] <= 0))
    )
      throw new RangeError("Forecast bounds must be finite and ordered");
    return { ...p, source: p, lo: bounds?.[0], hi: bounds?.[1] };
  });
};

export const lineDetailsEnabled = (opts: {
  forecast?: unknown;
  zero?: boolean;
  threshold?: unknown;
  marker?: unknown;
  legendValues?: boolean;
}) => !!(opts.forecast || opts.zero || opts.threshold || opts.marker || opts.legendValues);
