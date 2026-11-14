type NestedDotOptions = {
  marks?: "bars" | "dots";
  layout?: string;
  data?: { value: number | null }[];
  series?: { data: (number | null)[] }[];
  total?: number;
  dots?: number;
  compare?: { label: string; data: (number | null)[] };
  normalize?: boolean;
  yAxis?: { domain?: readonly number[]; scale?: string };
};

/** One nonnegative subset contract for portable schemas and direct core rendering. */
export function nestedDotOptions(
  opts: NestedDotOptions,
  issue: (message: string) => void = (message) => {
    throw new RangeError(message);
  },
) {
  if (opts.marks !== "dots") {
    if (opts.layout === "nested") issue("Nested bars need dot marks");
    if (opts.total !== undefined || opts.dots !== undefined) issue("Total/dots require dot marks");
    return;
  }
  if (opts.data?.some((d) => d.value !== null && Number.isFinite(d.value) && d.value < 0))
    issue("Dot matrices require nonnegative nested counts");
  const series = opts.series ?? [];
  const total = opts.total ?? Math.max(1, ...series.flatMap((s) => s.data.filter((v): v is number => v !== null && Number.isFinite(v))));
  const count = opts.dots ?? 100;
  if (opts.layout !== "nested" || !series.length || opts.compare || opts.normalize || opts.yAxis?.scale === "log")
    issue("Dots need nested linear series; no comparison or normalization");
  if (!Number.isFinite(total) || total <= 0 || !Number.isSafeInteger(count) || count < 2 || count % 2)
    issue("Dots need positive total and even count");
  if (opts.yAxis?.domain && (opts.yAxis.domain[0] !== 0 || opts.yAxis.domain[1] !== total)) issue("Dot domain must be zero to total");
  series.forEach((s, i) =>
    s.data.forEach((v, j) => {
      if (v === null || !Number.isFinite(v)) return;
      if (v < 0 || v > total) issue("Nested counts must be nonnegative and at most total");
      const parent = series[i - 1]?.data[j];
      if (i > 0 && parent != null && Number.isFinite(parent) && v > parent) issue("Counts must be a subset of the previous series");
    }),
  );
  return { total, count };
}
