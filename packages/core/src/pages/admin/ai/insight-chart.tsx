import { Chart } from "@k2b/ui";

export type TimePoint = { at: number; value: number | null };

/**
 * A line over time, drawn into the `Canvas` the screen places in its `Section`.
 * k2b-ui gap: `Chart` takes no series colour; it draws in the app's accent (Core), not in the AI colour of the content,
 * and errors in the palette's second colour instead of red. Missing measurements are gaps, never zero. Without a single
 * measurement the screen puts `Empty` in the canvas instead (`hasPoints`), so its height stays.
 */
export function TimeChart(props: {
  series: { label: string; points: TimePoint[] }[];
  /** The period's step in ms, so a missing step is a gap. */
  step: number;
  format: (value: number) => string;
  axis: (at: number) => string;
}) {
  const data = () =>
    props.series.map((series) => ({
      label: series.label,
      data: series.points.flatMap((point) => (point.value === null ? [] : [{ x: point.at, y: point.value }])),
    }));
  return (
    <Chart
      kind="line"
      style={{ height: "100%" }}
      series={data()}
      smooth={false}
      legend={props.series.length > 1}
      maxGap={props.step * 1.5}
      xAxis={{ ticks: 3, format: props.axis }}
      yAxis={{ format: props.format }}
    />
  );
}

/** Whether any series has a measured point; without one the canvas shows `Empty`. */
export const hasPoints = (series: { points: TimePoint[] }[]) => series.some((entry) => entry.points.some((point) => point.value !== null));

/** Bars of a few named values (the models by reference costs), drawn into the screen's `Canvas` (same colour gap). */
export function BarChart(props: { data: { label: string; value: number }[]; format: (value: number) => string }) {
  return <Chart kind="bar" style={{ height: "100%" }} data={props.data} yAxis={{ format: props.format }} />;
}
