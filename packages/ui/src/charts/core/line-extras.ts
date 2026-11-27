/** Bands, a line's colour scale and a track of bars under the plot: the opt-in extras of a detailed line chart. */
import {
  type AxisScale,
  computeAxisScale,
  escapeXml,
  type LineOptions,
  type LineScaleTone,
  type LineSeries,
  type LineTrack,
  type PlotArea,
  pickMapper,
} from "./svg-common";
import { fmt } from "./svg-format";

/** Each tone has a relative luminance between 0.136 and 0.30: at least 3:1 against #ffffff and against #18181b. */
export const lineScaleTones: Record<LineScaleTone, string> = {
  blue: "#3b82f6",
  cyan: "#0891b2",
  green: "#16a34a",
  amber: "#d97706",
  orange: "#ea580c",
  red: "#ef4444",
  violet: "#8b5cf6",
};

/** Throws for options a drawing could only show wrong. */
export const checkLineExtras = (opts: Pick<LineOptions, "series" | "bands" | "track" | "yAxis">) => {
  const log = opts.yAxis?.scale === "log";
  for (const band of opts.bands ?? [])
    if (!Number.isFinite(band.from) || !Number.isFinite(band.to) || band.from >= band.to)
      throw new RangeError("A line band needs a finite from below its finite to");
  if (opts.track && (!opts.track.label.trim() || (opts.track.height !== undefined && !(opts.track.height >= 16))))
    throw new RangeError("A line track needs a label and at least 16 px of height");
  for (const series of opts.series) {
    const stops = series.colorScale;
    if (!stops) continue;
    if (stops.length < 2) throw new RangeError("A colour scale needs at least two stops");
    for (const [index, stop] of stops.entries()) {
      if (!Number.isFinite(stop.value) || (index > 0 && stop.value <= stops[index - 1]!.value))
        throw new RangeError("Colour scale stops need finite values in rising order");
      if (!Object.hasOwn(lineScaleTones, stop.tone)) throw new RangeError(`Unknown colour scale tone: ${stop.tone}`);
      if (log && stop.value <= 0) throw new RangeError("Colour scale stops must be positive on a log axis");
    }
  }
};

/** The quiet ranges behind the data, clipped to the plot; each names itself to assistive technology by its label. */
export const lineBandsSvg = (bands: LineOptions["bands"], x: (value: number) => number, area: PlotArea) =>
  (bands ?? [])
    .map((band) => {
      const left = Math.max(area.x0, Math.min(area.x1, x(band.from)));
      const right = Math.max(area.x0, Math.min(area.x1, x(band.to)));
      if (right - left < 0.5) return "";
      const title = band.label ? `<title>${escapeXml(band.label)}</title>` : "";
      return `<rect class="k2b-line-band" x="${fmt(left)}" y="${fmt(area.y0)}" width="${fmt(right - left)}" height="${fmt(area.y1 - area.y0)}" fill="currentColor" fill-opacity=".06" stroke="none">${title}</rect>`;
    })
    .join("");

/** A stable id from what the gradient draws, so the server and the browser write the same markup. */
const gradientId = (seed: string) => {
  let hash = 2166136261;
  for (const sign of seed) hash = Math.imul(hash ^ sign.charCodeAt(0), 16777619) >>> 0;
  return `k2b-line-scale-${hash.toString(36)}`;
};

/**
 * A vertical gradient in the plot's own coordinates: a point of the line takes the colour of its value. Returns the
 * definition and the paint that refers to it.
 */
export const lineScaleGradient = (
  stops: NonNullable<LineSeries["colorScale"]>,
  y: (value: number) => number,
  seriesIndex: number,
  idPrefix?: string,
) => {
  const top = y(stops[0]!.value);
  const bottom = y(stops.at(-1)!.value);
  const offsets = stops.map((stop) => (y(stop.value) - top) / (bottom - top));
  // one id per chart on the page (`<Chart>` passes its own prefix); a bare drawing derives one from what it draws
  const id = idPrefix
    ? `${idPrefix}-scale-${seriesIndex}`
    : gradientId(`${seriesIndex}|${fmt(top)}|${fmt(bottom)}|${stops.map((stop) => `${stop.value}:${stop.tone}`).join(",")}`);
  const marks = stops.map((stop, index) => `<stop offset="${fmt(offsets[index]!)}" stop-color="${lineScaleTones[stop.tone]}"/>`).join("");
  return {
    defs: `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${fmt(top)}" y2="${fmt(bottom)}">${marks}</linearGradient>`,
    paint: `url(#${id})`,
  };
};

/** The scale from its first stop to its last, left to right, for a legend's swatch. */
export const lineScaleKey = (stops: NonNullable<LineSeries["colorScale"]>, seriesIndex: number, idPrefix?: string) => {
  const id = idPrefix ? `${idPrefix}-key-${seriesIndex}` : gradientId(`key|${seriesIndex}|${stops.map((stop) => stop.tone).join(",")}`);
  const marks = stops
    .map((stop, index) => `<stop offset="${fmt(index / (stops.length - 1))}" stop-color="${lineScaleTones[stop.tone]}"/>`)
    .join("");
  return { defs: `<linearGradient id="${id}">${marks}</linearGradient>`, paint: `url(#${id})` };
};

/** The tone a single value stands in: the last stop at or below it (the first stop below all of them). */
export const lineScaleToneAt = (stops: NonNullable<LineSeries["colorScale"]>, value: number) =>
  lineScaleTones[[...stops].reverse().find((stop) => stop.value <= value)?.tone ?? stops[0]!.tone];

/** The room above a track for its label; the track's own height comes after it. */
export const LINE_TRACK_GAP = 22;

/** The scale of a track: from 0 (unless its domain says otherwise) to its highest value, two labels. */
export const lineTrackScale = (track: LineTrack) => {
  const values = track.data.map((p) => p.y).filter(Number.isFinite);
  // a dry day: every value 0 (or none) keeps the scale at 0 to 1, never around 0
  if (!track.domain && values.every((value) => value === 0)) return computeAxisScale([0, 1], { domain: [0, 1], ticks: 2 });
  return computeAxisScale([...(track.domain ? [] : [0]), ...values], { domain: track.domain, ticks: 2 });
};

/**
 * A track: its label above it, its scale at its start (the lowest and the highest value, like the Y axis's labels),
 * a base line and a bar per value, centred on its X and as wide as the closest two X values leave room for. It lies
 * in its own strip under the plot, so nothing in it meets a line.
 */
export const lineTrackSvg = (track: LineTrack, scale: AxisScale, x: (value: number) => number, strip: PlotArea, paint: string) => {
  const format = track.format ?? ((value: number) => String(value));
  const map = pickMapper(scale.scale);
  const barY = (value: number) => map(value, scale.domain, [strip.y1, strip.y0]);
  const points = track.data.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x);
  let gap = Infinity;
  for (let index = 1; index < points.length; index++) gap = Math.min(gap, x(points[index]!.x) - x(points[index - 1]!.x));
  const width = Math.max(1, Math.min(16, Number.isFinite(gap) ? gap * 0.6 : 16));
  const base = barY(Math.max(scale.domain[0], Math.min(scale.domain[1], 0)));
  const ends = [scale.domain[0], scale.domain[1]];
  const parts = [
    `<text class="k2b-line-track-label" x="${fmt(strip.x0)}" y="${fmt(strip.y0 - 8)}" fill="currentColor" stroke="none" font-size="11" font-weight="600">${escapeXml(track.label)}</text>`,
    ...ends.map(
      (value) =>
        `<text class="stdlib-chart-tick-label k2b-line-track-tick" x="${fmt(strip.x0 - 6)}" y="${fmt(barY(value) + 3)}" text-anchor="end">${escapeXml(format(value))}</text>`,
    ),
    `<line class="stdlib-chart-axis k2b-line-track-base" x1="${fmt(strip.x0)}" x2="${fmt(strip.x1)}" y1="${fmt(base)}" y2="${fmt(base)}"/>`,
  ];
  for (const p of points) {
    const left = Math.max(strip.x0, x(p.x) - width / 2);
    const right = Math.min(strip.x1, x(p.x) + width / 2);
    const top = Math.max(strip.y0, Math.min(base, barY(p.y)));
    const height = Math.min(strip.y1, Math.max(base, barY(p.y))) - top;
    if (right <= left || height < 0.5) continue;
    parts.push(
      `<rect class="k2b-line-bar" x="${fmt(left)}" y="${fmt(top)}" width="${fmt(right - left)}" height="${fmt(height)}" rx="1" fill="${paint}" stroke="none"><title>${escapeXml(`${track.label} ${format(p.y)}`)}</title></rect>`,
    );
  }
  return `<g class="k2b-line-track">${parts.join("")}</g>`;
};
