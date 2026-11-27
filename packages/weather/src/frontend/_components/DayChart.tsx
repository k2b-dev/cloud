import { For, Show } from "solid-js";
import { cssColor, TONE_COLORS, temperatureColor } from "../weather-scale";
import type { WeatherHour } from "../weather-view";

/** Where the parts of the day stand, from the top of the drawing, in px. */
const TOP = 30; // air above the warmest hour, room for its label
const CURVE = 96; // the height of the temperature
const RAIN_TOP = TOP + CURVE + 16;
const RAIN = 36; // the height of a certain rain (100 %)
const BASE = RAIN_TOP + RAIN;
/** The drawing's height: the hours' labels stand under the base line. */
export const DAY_CHART_HEIGHT = BASE + 28;
/** Left: the degrees' labels; right: the text edge. */
const LEFT = 52;
const RIGHT = 20;
/** The x of the drawing is 0–1000 across the plot; the labels sit on the same share in HTML. */
const WIDTH = 1000;

/** Whole degrees around the hours, at least four apart, so a flat day does not look like a storm. */
const domain = (values: number[]): [number, number] => {
  let low = Math.floor(Math.min(...values));
  let high = Math.ceil(Math.max(...values));
  while (high - low < 4) {
    high += 1;
    if (high - low < 4) low -= 1;
  }
  return [low, high];
};

/** A smooth curve through the points that never overshoots them (monotone cubic, Fritsch–Carlson). */
const curvePath = (points: [number, number][]) => {
  if (points.length < 2) return "";
  const slopes = points.slice(1).map(([x, y], index) => (y - points[index]![1]) / (x - points[index]![0]));
  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0]!;
    if (index === points.length - 1) return slopes.at(-1)!;
    const [before, after] = [slopes[index - 1]!, slopes[index]!];
    return before * after <= 0 ? 0 : (2 * before * after) / (before + after);
  });
  return points
    .map(([x, y], index) => {
      if (index === 0) return `M${x},${y}`;
      const [px, py] = points[index - 1]!;
      const step = (x - px) / 3;
      return `C${px + step},${py + tangents[index - 1]! * step} ${x - step},${y - tangents[index]! * step} ${x},${y}`;
    })
    .join("");
};

const share = (index: number, count: number) => (count < 2 ? 0 : index / (count - 1));
/** A place across the plot as CSS: the labels and the dot stand where the drawing puts the hour. */
const across = (part: number) => `calc(${LEFT}px + (100% - ${LEFT + RIGHT}px) * ${part})`;

/**
 * The day in one drawing: the temperature of the next hours as a line in its colour from cold to warm, the chance of
 * rain as blue bars under it on the same hours, the night shaded, and "now" as a dot with its degrees. Strong for the
 * data, thin for the grid, a hairline for the base. The words of the curve stand in the canvas label; the drawing
 * itself is decoration for assistive technology.
 */
export default function DayChart(props: { hours: readonly WeatherHour[]; rain: string; locale: string }) {
  const count = () => props.hours.length;
  const range = () => domain(props.hours.map((hour) => hour.degrees));
  const yOf = (degrees: number) => TOP + ((range()[1] - degrees) / (range()[1] - range()[0])) * CURVE;
  const xOf = (index: number) => share(index, count()) * WIDTH;
  const points = () => props.hours.map((hour, index): [number, number] => [xOf(index), yOf(hour.degrees)]);
  const slot = () => WIDTH / Math.max(1, count() - 1);
  const degreesText = (value: number) => `${new Intl.NumberFormat(props.locale, { maximumFractionDigits: 0 }).format(value)}°`;
  // three lines of the grid: the lowest and highest whole degree and the middle
  const ticks = () => {
    const [low, high] = range();
    return [high, Math.round((low + high) / 2), low];
  };
  // the colour runs along the degrees, not along the hours: each height of the curve has the colour of its degrees
  const stops = () => {
    const [low, high] = range();
    return Array.from({ length: 9 }, (_, index) => {
      const degrees = high - ((high - low) * index) / 8;
      return { offset: index / 8, color: temperatureColor(degrees) };
    });
  };
  // the hours that stand out by their degrees: now, the warmest and the coldest, each named once
  const marks = () => {
    const hours = props.hours;
    const warmest = hours.reduce((best, hour, index) => (hour.degrees > hours[best]!.degrees ? index : best), 0);
    const coldest = hours.reduce((best, hour, index) => (hour.degrees < hours[best]!.degrees ? index : best), 0);
    return [...new Set([0, warmest, coldest])].filter((index) => index === 0 || Math.abs(index) >= 2);
  };
  // the night as one band per run of dark hours, from half an hour before the first to half an hour after the last
  const nights = () => {
    const runs: [number, number][] = [];
    props.hours.forEach((hour, index) => {
      if (!hour.night) return;
      const last = runs.at(-1);
      if (last && last[1] === index - 1) last[1] = index;
      else runs.push([index, index]);
    });
    return runs.map(([from, to]) => ({
      x: Math.max(0, xOf(from) - slot() / 2),
      width: Math.min(WIDTH, xOf(to) + slot() / 2) - Math.max(0, xOf(from) - slot() / 2),
    }));
  };
  const labelEvery = () => (count() > 9 ? 3 : 2);
  const label = { font: "var(--k2-t-meta)", color: "var(--k2-subtle)", position: "absolute", "white-space": "nowrap" } as const;

  return (
    <div style={{ position: "relative", height: `${DAY_CHART_HEIGHT}px`, "font-variant-numeric": "tabular-nums" }}>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${WIDTH} ${DAY_CHART_HEIGHT}`}
        preserveAspectRatio="none"
        style={{
          position: "absolute",
          top: 0,
          left: `${LEFT}px`,
          width: `calc(100% - ${LEFT + RIGHT}px)`,
          height: "100%",
          overflow: "visible",
        }}
      >
        <defs>
          <linearGradient id="weather-day-degrees" gradientUnits="userSpaceOnUse" x1="0" y1={TOP} x2="0" y2={TOP + CURVE}>
            <For each={stops()}>{(stop) => <stop offset={stop.offset} style={{ "stop-color": stop.color }} />}</For>
          </linearGradient>
        </defs>
        {/* the night: a quiet band behind everything */}
        <For each={nights()}>
          {(night) => <rect x={night.x} y={0} width={night.width} height={BASE} style={{ fill: "var(--k2-n100)" }} />}
        </For>
        {/* the grid: thin lines at three degrees */}
        <For each={ticks()}>
          {(tick) => (
            <line
              x1={0}
              x2={WIDTH}
              y1={yOf(tick)}
              y2={yOf(tick)}
              vector-effect="non-scaling-stroke"
              style={{ stroke: "var(--k2-line)", "stroke-width": "1px", "stroke-dasharray": "2 4" }}
            />
          )}
        </For>
        {/* the rain: blue bars on the same hours, their full height a certain rain */}
        <For each={props.hours}>
          {(hour, index) => (
            <Show when={hour.rainChance}>
              {(chance) => (
                <rect
                  x={xOf(index()) - slot() * 0.22}
                  y={BASE - (RAIN * chance()) / 100}
                  width={slot() * 0.44}
                  height={(RAIN * chance()) / 100}
                  style={{ fill: cssColor(TONE_COLORS.rain) }}
                />
              )}
            </Show>
          )}
        </For>
        {/* the base: a hairline under the rain */}
        <line
          x1={0}
          x2={WIDTH}
          y1={BASE}
          y2={BASE}
          vector-effect="non-scaling-stroke"
          style={{ stroke: "var(--k2-line-control)", "stroke-width": "1px" }}
        />
        {/* the temperature: a quiet tint under it and the strong line in the colour of its degrees */}
        <path
          d={`${curvePath(points())}L${WIDTH},${TOP + CURVE}L0,${TOP + CURVE}Z`}
          style={{ fill: "url(#weather-day-degrees)", "fill-opacity": 0.1 }}
        />
        <path
          d={curvePath(points())}
          vector-effect="non-scaling-stroke"
          style={{
            fill: "none",
            stroke: "url(#weather-day-degrees)",
            "stroke-width": "3px",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
          }}
        />
      </svg>
      {/* the degrees of the grid, at the left text edge */}
      <For each={ticks()}>{(tick) => <span style={{ ...label, left: "20px", top: `${yOf(tick) - 8}px` }}>{degreesText(tick)}</span>}</For>
      {/* the rain's scale: its words at the left, beside its bars */}
      <span style={{ ...label, left: "20px", top: `${BASE - 16}px` }}>{props.rain}</span>
      {/* now, the warmest and the coldest hour: a dot on the line and its degrees above it */}
      <For each={marks()}>
        {(index) => {
          const hour = () => props.hours[index]!;
          return (
            <>
              <span
                style={{
                  position: "absolute",
                  left: across(share(index, count())),
                  top: `${yOf(hour().degrees)}px`,
                  width: index === 0 ? "10px" : "6px",
                  height: index === 0 ? "10px" : "6px",
                  "border-radius": "50%",
                  transform: "translate(-50%, -50%)",
                  background: temperatureColor(hour().degrees),
                  "box-shadow": "0 0 0 2px var(--k2-surface)",
                }}
              />
              <span
                style={{
                  ...label,
                  color: "var(--k2-text)",
                  "font-weight": index === 0 ? 600 : 400,
                  left: across(share(index, count())),
                  top: `${yOf(hour().degrees) - 24}px`,
                  transform: index === 0 ? "none" : index === count() - 1 ? "translateX(-100%)" : "translateX(-50%)",
                }}
              >
                {hour().temperature}
              </span>
            </>
          );
        }}
      </For>
      {/* the hours under the base, every second or third; the first is "now" (the forecast names it so) */}
      <For each={props.hours}>
        {(hour, index) => (
          <Show when={index() % labelEvery() === 0}>
            <span
              style={{
                ...label,
                color: index() === 0 ? "var(--k2-text)" : label.color,
                "font-weight": index() === 0 ? 600 : 400,
                left: across(share(index(), count())),
                top: `${BASE + 6}px`,
                transform: index() === 0 ? "none" : index() === count() - 1 ? "translateX(-100%)" : "translateX(-50%)",
              }}
            >
              {hour.time}
            </span>
          </Show>
        )}
      </For>
    </div>
  );
}
