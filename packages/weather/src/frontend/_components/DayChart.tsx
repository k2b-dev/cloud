import { For, Show } from "solid-js";
import { cssColor, RAIN_SOFT, TONE_COLORS, temperatureColor } from "../weather-scale";
import type { WeatherHour } from "../weather-view";

/**
 * Where the parts of the day stand, in px from the top: air above the warmest hour (room for its label), the height of
 * the temperature, a gap, the height of a certain rain (100 %), and the hours' labels under the base line. The left
 * column holds the degrees' labels; the right keeps the text edge.
 */
type Geometry = {
  top: number;
  curve: number;
  gap: number;
  rain: number;
  axis: number;
  left: number;
  /** The share of an hour a rain bar takes. */
  bar: number;
  /** The rain's colour: strong in the wide drawing, softer on the phone. */
  rainColor: string;
  /** The phone's drawing is quieter: two degrees and one grid line, the night as a thin band on the time axis. */
  compact: boolean;
};
const WIDE: Geometry = {
  top: 30,
  curve: 96,
  gap: 16,
  rain: 36,
  axis: 28,
  left: 60,
  bar: 0.44,
  rainColor: cssColor(TONE_COLORS.rain),
  compact: false,
};
const PHONE: Geometry = {
  top: 24,
  curve: 76,
  gap: 10,
  rain: 22,
  axis: 26,
  left: 40,
  bar: 0.24,
  rainColor: cssColor(RAIN_SOFT),
  compact: true,
};
/** The right keeps the text edge (16 px on the phone, 20 px wide). */
const RIGHT = "var(--k2-edge)";
/** The x of the drawing is 0–1000 across the plot; the labels sit on the same share in HTML. */
const WIDTH = 1000;
const base = (g: Geometry) => g.top + g.curve + g.gap + g.rain;
/** The drawing's height in px. */
export const dayChartHeight = (compact: boolean) => {
  const g = compact ? PHONE : WIDE;
  return base(g) + g.axis;
};

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

/**
 * The day in one drawing: the temperature of the next hours as a line in its colour from cold to warm, the chance of
 * rain as blue bars under it on the same hours, the night shaded, and "now" as a dot with its degrees. Strong for the
 * data, thin for the grid, a hairline for the base. `compact` is the phone's quieter drawing (about 160 px): two
 * degrees, one faint grid line, thin soft rain bars without their word, the night as a thin band along the time axis.
 * The words of the curve stand in the canvas label; the drawing itself is decoration for assistive technology.
 *
 * k2b-ui gap: `Chart` has no `bands` (shaded x-ranges such as the night), no `colorScale` for a line (its colour by
 * value), and no bar series on its own axis beside a line on one time axis; owner G. When they land, the day moves onto
 * `Chart` with the stops of `weather-scale.ts`, and this drawing goes.
 */
export default function DayChart(props: { hours: readonly WeatherHour[]; rain: string; locale: string; compact?: boolean }) {
  const g = () => (props.compact ? PHONE : WIDE);
  const id = () => `weather-day-degrees-${props.compact ? "phone" : "wide"}`;
  const count = () => props.hours.length;
  const range = () => domain(props.hours.map((hour) => hour.degrees));
  const yOf = (degrees: number) => g().top + ((range()[1] - degrees) / (range()[1] - range()[0])) * g().curve;
  const xOf = (index: number) => share(index, count()) * WIDTH;
  const points = () => props.hours.map((hour, index): [number, number] => [xOf(index), yOf(hour.degrees)]);
  const slot = () => WIDTH / Math.max(1, count() - 1);
  /** A place across the plot as CSS: the labels and the dot stand where the drawing puts the hour. */
  const across = (part: number) => `calc(${g().left}px + (100% - ${g().left}px - ${RIGHT}) * ${part})`;
  const degreesText = (value: number) => `${new Intl.NumberFormat(props.locale, { maximumFractionDigits: 0 }).format(value)}°`;
  // the degrees written at the left: the highest, the middle and the lowest whole degree; on the phone only the ends
  const ticks = () => {
    const [low, high] = range();
    return props.compact ? [high, low] : [high, Math.round((low + high) / 2), low];
  };
  // the grid's lines: one at each written degree; on the phone one faint line in the middle
  const grid = () => {
    const [low, high] = range();
    return props.compact ? [(low + high) / 2] : ticks();
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
    return [...new Set([0, warmest, coldest])].filter((index) => index === 0 || index >= 2);
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
  const height = () => base(g()) + g().axis;

  return (
    <div style={{ position: "relative", height: `${height()}px`, "font-variant-numeric": "tabular-nums" }}>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${WIDTH} ${height()}`}
        preserveAspectRatio="none"
        style={{
          position: "absolute",
          top: 0,
          left: `${g().left}px`,
          width: `calc(100% - ${g().left}px - ${RIGHT})`,
          height: "100%",
          overflow: "visible",
        }}
      >
        <defs>
          <linearGradient id={id()} gradientUnits="userSpaceOnUse" x1="0" y1={g().top} x2="0" y2={g().top + g().curve}>
            <For each={stops()}>{(stop) => <stop offset={stop.offset} style={{ "stop-color": stop.color }} />}</For>
          </linearGradient>
        </defs>
        {/* the night: a quiet band behind everything, on the phone a thin band along the time axis */}
        <For each={nights()}>
          {(night) =>
            props.compact ? (
              <rect x={night.x} y={base(g()) + 2} width={night.width} height={3} style={{ fill: "var(--k2-n300)" }} />
            ) : (
              <rect x={night.x} y={0} width={night.width} height={base(g())} style={{ fill: "var(--k2-n100)" }} />
            )
          }
        </For>
        {/* the grid: thin dashed lines */}
        <For each={grid()}>
          {(tick) => (
            <line
              x1={0}
              x2={WIDTH}
              y1={yOf(tick)}
              y2={yOf(tick)}
              vector-effect="non-scaling-stroke"
              style={{
                stroke: "var(--k2-line)",
                "stroke-width": "1px",
                "stroke-dasharray": "2 4",
                opacity: props.compact ? 0.7 : 1,
              }}
            />
          )}
        </For>
        {/* the rain: bars on the same hours, their full height a certain rain; the first and last stay in the plot */}
        <For each={props.hours}>
          {(hour, index) => (
            <Show when={hour.rainChance}>
              {(chance) => (
                <rect
                  x={Math.max(0, xOf(index()) - (slot() * g().bar) / 2)}
                  y={base(g()) - (g().rain * chance()) / 100}
                  width={Math.min(WIDTH, xOf(index()) + (slot() * g().bar) / 2) - Math.max(0, xOf(index()) - (slot() * g().bar) / 2)}
                  height={(g().rain * chance()) / 100}
                  style={{ fill: g().rainColor }}
                />
              )}
            </Show>
          )}
        </For>
        {/* the base: a hairline under the rain */}
        <line
          x1={0}
          x2={WIDTH}
          y1={base(g())}
          y2={base(g())}
          vector-effect="non-scaling-stroke"
          style={{ stroke: "var(--k2-line-control)", "stroke-width": "1px" }}
        />
        {/* the temperature: a quiet tint under it and the strong line in the colour of its degrees */}
        <path
          d={`${curvePath(points())}L${WIDTH},${g().top + g().curve}L0,${g().top + g().curve}Z`}
          style={{ fill: `url(#${id()})`, "fill-opacity": 0.1 }}
        />
        <path
          d={curvePath(points())}
          vector-effect="non-scaling-stroke"
          style={{
            fill: "none",
            stroke: `url(#${id()})`,
            "stroke-width": props.compact ? "2.5px" : "3px",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
          }}
        />
      </svg>
      {/* the degrees, at the left text edge */}
      <For each={ticks()}>
        {(tick) => <span style={{ ...label, left: "var(--k2-edge)", top: `${yOf(tick) - 8}px` }}>{degreesText(tick)}</span>}
      </For>
      {/* the rain's scale: its words at the left, beside its bars (on the phone the soft blue bars speak for themselves) */}
      <Show when={!props.compact}>
        <span style={{ ...label, left: "var(--k2-edge)", top: `${base(g()) - 16}px` }}>{props.rain}</span>
      </Show>
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
                top: `${base(g()) + (props.compact ? 8 : 6)}px`,
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
