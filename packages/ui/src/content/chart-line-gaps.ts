import { linePathD, smoothPathD, stepPathD, type ChartDatum } from "@k2b/stdlib";
import { isChartDatum } from "./chart-inspection";

/** Adapt trusted stdlib line geometry without changing series, indices or inspection. */
export function lineGapsSvg(svg: string, maxGap: number, options: { smooth?: boolean; step?: "before" | "after" | "middle" }): string {
  if (!Number.isFinite(maxGap) || maxGap <= 0) throw new RangeError("Chart maxGap must be finite and positive");
  const decode = (value: string) =>
    value
      .replace(/&quot;/g, '"')
      .replace(/&apos;|&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  const series = new Map<number, ChartDatum[]>();
  const records: ChartDatum[] = [];
  for (const match of svg.matchAll(/data-chart-datum="([^"]*)"/g)) {
    const datum: unknown = JSON.parse(decode(match[1]!));
    if (!isChartDatum(datum) || datum.role !== "point") continue;
    records.push(datum);
    const index = datum.seriesIndex ?? 0;
    const rows = series.get(index) ?? [];
    rows.push(datum);
    series.set(index, rows);
  }
  const x = (point: ChartDatum) => Number(point.values.find((value) => value.key === "x")!.value);
  const paths = new Map<number, string>();
  const isolated = new Set<ChartDatum>();
  for (const [index, points] of series) {
    const runs: ChartDatum[][] = [];
    for (const point of [...points].sort((a, b) => x(a) - x(b))) {
      const run = runs.at(-1);
      if (!run || x(point) - x(run.at(-1)!) > maxGap) runs.push([point]);
      else run.push(point);
    }
    paths.set(
      index,
      runs
        .map((run) => {
          if (run.length === 1) {
            isolated.add(run[0]!);
            return "";
          }
          const points = run.map((point) => ({ x: point.anchor[0], y: point.anchor[1] }));
          return options.step ? stepPathD(points, options.step) : options.smooth === false ? linePathD(points) : smoothPathD(points);
        })
        .join(" "),
    );
  }
  // Metadata precedes each series' path in the renderer. Keeping the source
  // series index also preserves palettes when there are more than eight series.
  let currentSeries = 0;
  let pointIndex = 0;
  return svg.replace(
    /<g data-chart-role="point" data-chart-datum="[^"]*">[\s\S]*?<\/g>|<path class="stdlib-chart-line [^"]*"[^>]*\/>/g,
    (element) => {
      if (element.startsWith("<g")) {
        const datum = records[pointIndex++]!;
        currentSeries = datum.seriesIndex ?? 0;

        return isolated.has(datum)
          ? element.replace('fill="transparent"', `fill="var(--stdlib-chart-c${(currentSeries % 8) + 1})"`)
          : element;
      }
      return element.replace(/ d="[^"]*"/, ` d="${paths.get(currentSeries) ?? ""}"`);
    },
  );
}
