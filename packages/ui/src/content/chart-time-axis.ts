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

/** A clock time in the axis's zone, always 24 hours: "07:00". */
export const chartClock = (instant: number, axis: ChartTimeAxis): string =>
  new Intl.DateTimeFormat(axis.locale ?? "en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: axis.timeZone }).format(
    instant,
  );

/**
 * A span of milliseconds in the unit of its size, the number in `locale`: "4 s" and "2,5 s", "12 min", "1 h 30 min".
 * Seconds below ten keep one decimal; minutes and hours are whole.
 */
export const chartDuration = (milliseconds: number, locale = "en"): string => {
  const number = (value: number, digits = 0) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 59.5) return `${number(seconds, seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${number(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${number(hours)} h ${number(rest)} min` : `${number(hours)} h`;
};

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
