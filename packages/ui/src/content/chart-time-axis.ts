import { instantToZonedInput, zonedDateTimeToInstant } from "@k2b/stdlib";
import { type ChartTimeAxis, type ChartTimeStep, calendarTimeLabel, calendarTimeTicks, chartTimeStep } from "./chart-time-calendar";

export type { ChartTimeAxis, ChartTimeStep, ChartTimeUnit } from "./chart-time-calendar";
export { chartTimeStep };

const wallOf = (instant: number, timeZone: string) => Date.parse(`${instantToZonedInput(new Date(instant), timeZone)}:00Z`);
const instantOf = (wall: number, timeZone: string) =>
  Date.parse(zonedDateTimeToInstant(new Date(wall).toISOString().slice(0, 16), timeZone, { disambiguation: "compatible" }));
export const chartTimeTicks = (domain: readonly [number, number], timeZone: string, step: ChartTimeStep) =>
  calendarTimeTicks(domain, timeZone, step, { wallOf, instantOf });
export const chartTimeLabel = (tick: number, step: ChartTimeStep, axis: ChartTimeAxis) =>
  calendarTimeLabel(tick, step, axis, instantToZonedInput(new Date(tick), axis.timeZone).endsWith("T00:00"));

const dayOf = (instant: number, timeZone: string) => instantToZonedInput(new Date(instant), timeZone).slice(0, 10);

/** Whether the span from `from` up to (not including) `to` reaches into a second day of the zone's calendar. */
export const chartCrossesDay = (from: number, to: number, timeZone: string): boolean =>
  dayOf(from, timeZone) !== dayOf(Math.max(from, to - 1), timeZone);

/** A moment in the axis's zone, always 24 hours: "07:00", or with its day "26. Nov., 07:00". */
export const chartClock = (instant: number, axis: ChartTimeAxis, withDay = false): string =>
  new Intl.DateTimeFormat(axis.locale ?? "en", {
    ...(withDay ? { day: "numeric", month: "short" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: axis.timeZone,
  } as const).format(instant);

const escapeText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const xTickLabel = /<text class="stdlib-chart-tick-label" x="(-?[\d.]+)" y="(-?[\d.]+)" text-anchor="middle">[^<]*<\/text>/g;

/**
 * Replaces the renderer's X tick labels, which sit on decimal millisecond steps, with labels on round times. The
 * renderer drew the X axis over the explicit `domain`, so its horizontal axis line gives the pixel scale.
 */
export function timeAxisSvg(
  svg: string,
  domain: readonly [number, number],
  axis: ChartTimeAxis,
  maxTicks: number,
  format?: (value: number) => string,
): string {
  const axisLine = [
    ...svg.matchAll(/<line class="stdlib-chart-axis" x1="(-?[\d.]+)" y1="(-?[\d.]+)" x2="(-?[\d.]+)" y2="(-?[\d.]+)"\/>/g),
  ].find((match) => match[2] === match[4]);
  const first = xTickLabel.exec(svg);
  xTickLabel.lastIndex = 0;
  if (!axisLine || !first || !(domain[1] > domain[0])) return svg;
  const x0 = Number(axisLine[1]),
    x1 = Number(axisLine[3]),
    y = first[2];
  const step = chartTimeStep(domain[1] - domain[0], maxTicks);
  const labels = chartTimeTicks(domain, axis.timeZone, step)
    .map((tick) => {
      const x = x0 + ((tick - domain[0]) / (domain[1] - domain[0])) * (x1 - x0);
      const label = format ? format(tick) : chartTimeLabel(tick, step, axis);
      return `<text class="stdlib-chart-tick-label" x="${Math.round(x * 100) / 100}" y="${y}" text-anchor="middle">${escapeText(label)}</text>`;
    })
    .join("");
  let inserted = false;
  return svg.replace(xTickLabel, () => {
    if (inserted) return "";
    inserted = true;
    return labels;
  });
}
