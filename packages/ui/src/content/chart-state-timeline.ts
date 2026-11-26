import {
  chartDatumSvg,
  computeDomain,
  escapeXml,
  extendDomainToNice,
  mapRange,
  niceStep,
  seriesPaint,
  svgRoot,
} from "../charts/core/svg-renderers";
import { durationIn } from "../intl/duration";
import { type ChartTimeAxis, chartClock, chartCrossesDay, chartTimeLabel, chartTimeStep, chartTimeTicks } from "./chart-time-axis";

export type StateTimelineDomain = readonly [number, number];

export type StateTimelineInterval = {
  from: number;
  to: number;
  state: string;
  label?: string;
  href?: string;
  tooltip?: string;
};

export type StateTimelineRow = {
  label: string;
  href?: string;
  tooltip?: string;
  intervals: StateTimelineInterval[];
};

export type StateTimelineState = {
  state: string;
  label?: string;
  color?: string;
};

export type StateTimelineChartOptions = {
  rows: StateTimelineRow[];
  states?: StateTimelineState[];
  domain?: StateTimelineDomain;
  xAxis?: { format?: (value: number) => string; label?: string };
  /**
   * The times are instants (Unix milliseconds): the axis steps on round wall times in `timeZone` (hours across a day,
   * days across weeks), as a line chart's `timeAxis` does, its labels in `locale` (24 hours; the day at midnight);
   * the tooltip gives clock times, with the day when the view or the run reaches into a second day, and each
   * duration in the library's one wording ("4 Sek.", "12 Min", "1 Std. 30"). `xAxis.format` still labels the axis
   * and the times. `Chart` fills `locale` from the page.
   */
  timeAxis?: ChartTimeAxis;
  /**
   * Words a run's duration in the tooltip when `timeAxis` is set; `Chart` takes the words from its message catalog.
   * Without it they follow `timeAxis.locale`.
   */
  formatDuration?: (milliseconds: number) => string;
  legend?: boolean;
  interactive?: boolean;
  /**
   * Starts the ids of the drawing's own definitions (the clip of the lane names), so two drawings on one page never
   * share one; `Chart` gives each instance its own. Without it the ids come from the geometry.
   */
  idPrefix?: string;
};

const ROW_HEIGHT = 24;
const TOP = 38;
const AXIS_HEIGHT = 28;
const LEGEND_HEIGHT = 24;
const MIN_VIEW_FRACTION = 1 / 64;

const finiteDomain = (domain: StateTimelineDomain): StateTimelineDomain | null => {
  if (!Number.isFinite(domain[0]) || !Number.isFinite(domain[1]) || domain[0] === domain[1]) return null;
  return domain[0] < domain[1] ? domain : [domain[1], domain[0]];
};

export const stateTimelineDomain = (rows: readonly StateTimelineRow[], domain?: StateTimelineDomain): StateTimelineDomain => {
  const explicit = domain ? finiteDomain(domain) : null;
  if (explicit) return explicit;
  return computeDomain(rows.flatMap((row) => row.intervals.flatMap((interval) => [interval.from, interval.to])));
};

export const normalizeStateTimelineViewport = (
  viewport: StateTimelineDomain | undefined,
  fullDomain: StateTimelineDomain,
): StateTimelineDomain => {
  const full = finiteDomain(fullDomain) ?? [0, 1];
  const candidate = viewport ? finiteDomain(viewport) : null;
  if (!candidate) return full;
  const span = Math.min(candidate[1] - candidate[0], full[1] - full[0]);
  const from = Math.max(full[0], Math.min(candidate[0], full[1] - span));
  return [from, from + span];
};

export const zoomStateTimelineViewport = (
  viewport: StateTimelineDomain,
  fullDomain: StateTimelineDomain,
  delta: number,
  anchor = 0.5,
): StateTimelineDomain => {
  const current = normalizeStateTimelineViewport(viewport, fullDomain);
  const fullSpan = fullDomain[1] - fullDomain[0];
  const minSpan = Math.max(1, fullSpan * MIN_VIEW_FRACTION);
  const factor = delta > 0 ? 0.7 : 1 / 0.7;
  const nextSpan = Math.max(minSpan, Math.min(fullSpan, (current[1] - current[0]) * factor));
  const safeAnchor = Math.max(0, Math.min(1, anchor));
  const anchorValue = current[0] + (current[1] - current[0]) * safeAnchor;
  return normalizeStateTimelineViewport([anchorValue - nextSpan * safeAnchor, anchorValue + nextSpan * (1 - safeAnchor)], fullDomain);
};

export const panStateTimelineViewport = (
  viewport: StateTimelineDomain,
  fullDomain: StateTimelineDomain,
  pixelDelta: number,
  plotWidth: number,
): StateTimelineDomain => {
  if (plotWidth <= 0) return normalizeStateTimelineViewport(viewport, fullDomain);
  const current = normalizeStateTimelineViewport(viewport, fullDomain);
  const timeDelta = (-pixelDelta / plotWidth) * (current[1] - current[0]);
  return normalizeStateTimelineViewport([current[0] + timeDelta, current[1] + timeDelta], fullDomain);
};

export const stateTimelineHeight = (rows: number, legend = true): number =>
  Math.max(160, TOP + rows * ROW_HEIGHT + AXIS_HEIGHT + (legend ? LEGEND_HEIGHT : 0));

const fmt = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(2));

const safeHref = (href: string | undefined): string | null => (href && href.startsWith("/") && !href.startsWith("//") ? href : null);

const interactiveGroup = (body: string, href: string | undefined, tooltip: string | undefined, ariaLabel: string): string => {
  const safe = safeHref(href);
  const attrs = [`aria-label="${escapeXml(ariaLabel)}"`, tooltip ? `data-chart-tooltip="${escapeXml(tooltip)}"` : ""]
    .filter(Boolean)
    .join(" ");
  const title = tooltip ? `<title>${escapeXml(tooltip)}</title>` : "";
  return safe
    ? `<a href="${escapeXml(safe)}" ${attrs}>${title}${body}</a>`
    : `<g ${attrs}${tooltip ? ' role="img"' : ""}>${title}${body}</g>`;
};

export const renderStateTimelineSvg = (
  opts: StateTimelineChartOptions & {
    width: number;
    height: number;
    viewport?: StateTimelineDomain;
    className?: string;
  },
): string => {
  const { width, height, rows } = opts;
  const fullDomain = stateTimelineDomain(rows, opts.domain);
  const viewport = normalizeStateTimelineViewport(opts.viewport, fullDomain);
  const showLegend = opts.legend !== false && (opts.states?.length ?? 0) > 0;
  const legendHeight = showLegend ? LEGEND_HEIGHT : 0;
  const labels = rows.map((row) => row.label);
  const idealGutter = Math.max(72, ...labels.map((label) => label.length * 6.3 + 20));
  const gutter = Math.min(240, width * 0.35, idealGutter);
  const plotLeft = gutter;
  const plotRight = Math.max(plotLeft + 1, width - 16);
  const rowsBottom = Math.min(height - AXIS_HEIGHT - legendHeight, TOP + rows.length * ROW_HEIGHT);
  const stateStyles = new Map((opts.states ?? []).map((state, index) => [state.state, { ...state, index }]));
  const stateKeys = opts.states?.map((state) => state.state) ?? [...new Set(rows.flatMap((row) => row.intervals.map((i) => i.state)))];
  const stateIndexes = new Map(stateKeys.map((state, index) => [state, index]));
  const body: string[] = [];
  const lanes: string[] = [];
  // A start or end in the tooltip: the page's format, else the clock time of an instant, with its day when the view
  // or the run reaches into a second day (a week, a run over midnight), so a time never stands for two moments.
  const timeAxis = opts.timeAxis;
  const viewCrossesDay = timeAxis ? chartCrossesDay(viewport[0], viewport[1], timeAxis.timeZone) : false;
  const when = (value: number, withDay: boolean) =>
    opts.xAxis?.format?.(value) ?? (timeAxis ? chartClock(value, timeAxis, withDay) : undefined);
  // only an instant has a duration in time; plain numbers keep theirs as a number
  const duration = timeAxis ? (opts.formatDuration ?? durationIn(timeAxis.locale)) : undefined;
  // A host stretches the drawing to its box while text keeps its pixel size, so the room a lane name has in pixels is
  // known only in the browser. Each name starts at the left edge and the gutter cuts it off with a short fade: in the
  // drawing's own units, the cut scales with the box and always ends before the plot. The full name stays in the
  // link's title and accessible name. Each drawing of `Chart` has ids of its own: an id that two drawings share points
  // into the first, and a hidden first one clips nothing. A drawing without a prefix takes ids from its geometry.
  const labelRight = Math.max(8, plotLeft - 8);
  const lanesId = opts.idPrefix ? `${opts.idPrefix}-lanes` : `stdlib-chart-lanes-${fmt(labelRight)}-${fmt(height)}`;

  rows.forEach((row, rowIndex) => {
    const y = TOP + rowIndex * ROW_HEIGHT;
    if (y + ROW_HEIGHT > rowsBottom + 1) return;
    const labelBody = `<text class="stdlib-chart-state-label" x="0" y="${fmt(
      y + ROW_HEIGHT / 2,
    )}" text-anchor="start" dominant-baseline="middle">${escapeXml(row.label)}</text>`;
    lanes.push(interactiveGroup(labelBody, row.href, row.tooltip ?? row.label, row.label));

    for (const [index, interval] of row.intervals.entries()) {
      if (!Number.isFinite(interval.from) || !Number.isFinite(interval.to)) continue;
      const intervalFrom = Math.min(interval.from, interval.to);
      const intervalTo = Math.max(interval.from, interval.to);
      if (intervalTo < viewport[0] || intervalFrom > viewport[1]) continue;
      const from = Math.max(viewport[0], intervalFrom);
      const to = Math.min(viewport[1], intervalTo);
      const x = mapRange(from, viewport, [plotLeft, plotRight]);
      const x2 = mapRange(to, viewport, [plotLeft, plotRight]);
      const style = stateStyles.get(interval.state);
      const stateIndex = style?.index ?? stateIndexes.get(interval.state) ?? 0;
      const rect = `<rect ${seriesPaint(style?.color, stateIndex, "stdlib-chart-state-region")} x="${fmt(
        x,
      )}" y="${fmt(y + 3)}" width="${fmt(Math.max(2, x2 - x))}" height="${ROW_HEIGHT - 6}" rx="3"/>`;
      const stateLabel = style?.label ?? interval.state;
      const withDay = viewCrossesDay || (timeAxis ? chartCrossesDay(intervalFrom, intervalTo, timeAxis.timeZone) : false);
      body.push(
        interactiveGroup(
          chartDatumSvg(
            rect,
            {
              index,
              seriesIndex: rowIndex,
              role: "interval",
              label: row.label,
              anchor: [(x + x2) / 2, y + ROW_HEIGHT / 2],
              grid: [index, rowIndex],
              values: [
                { key: "state", value: interval.state, formatted: stateLabel },
                { key: "from", value: intervalFrom, formatted: when(intervalFrom, withDay) },
                { key: "to", value: intervalTo, formatted: when(intervalTo, withDay) },
                { key: "duration", value: intervalTo - intervalFrom, formatted: duration?.(intervalTo - intervalFrom) },
                ...((interval.tooltip ?? interval.label) ? [{ key: "detail", value: interval.tooltip ?? interval.label ?? "" }] : []),
              ],
            },
            opts.interactive,
          ),
          interval.href,
          interval.tooltip ?? interval.label,
          [row.label, interval.label, stateLabel].filter(Boolean).join(", "),
        ),
      );
    }
  });

  if (lanes.length > 0) {
    const fadeFrom = Math.max(0, labelRight - 16);
    body.unshift(
      `<defs><linearGradient id="${lanesId}-fade" gradientUnits="userSpaceOnUse" x1="${fmt(fadeFrom)}" y1="0" x2="${fmt(
        labelRight,
      )}" y2="0"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
        `<mask id="${lanesId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${fmt(labelRight)}" height="${fmt(height)}">` +
        `<rect x="0" y="0" width="${fmt(labelRight)}" height="${fmt(height)}" fill="url(#${lanesId}-fade)"/></mask>` +
        `<clipPath id="${lanesId}-clip"><rect x="0" y="0" width="${fmt(labelRight)}" height="${fmt(height)}"/></clipPath></defs>`,
      // a name starts at the left edge in a page written right to left too: `start` would be the right edge there
      `<g class="stdlib-chart-state-labels" direction="ltr" mask="url(#${lanesId})" clip-path="url(#${lanesId}-clip)">${lanes.join("")}</g>`,
    );
  }

  // instants step on round wall times, as many as fit at about 48 units a label; plain numbers on nice steps
  const timeStep = timeAxis ? chartTimeStep(viewport[1] - viewport[0], Math.max(4, Math.floor((plotRight - plotLeft) / 48))) : undefined;
  const tickTarget = Math.max(2, Math.min(8, Math.floor((plotRight - plotLeft) / 110)));
  const ticks =
    timeAxis && timeStep
      ? chartTimeTicks(viewport, timeAxis.timeZone, timeStep)
      : extendDomainToNice(viewport[0], viewport[1], niceStep(viewport[1] - viewport[0], tickTarget)).ticks;
  const format =
    opts.xAxis?.format ??
    (timeAxis && timeStep ? (value: number) => chartTimeLabel(value, timeStep, timeAxis) : (value: number) => fmt(value));
  for (const tick of ticks) {
    if (tick < viewport[0] || tick > viewport[1]) continue;
    const x = mapRange(tick, viewport, [plotLeft, plotRight]);
    body.push(
      `<line x1="${fmt(x)}" x2="${fmt(x)}" y1="${TOP}" y2="${fmt(rowsBottom)}" stroke="currentColor" opacity="0.08"/>`,
      `<text class="stdlib-chart-heatmap-label" x="${fmt(x)}" y="${fmt(rowsBottom + 17)}" text-anchor="middle">${escapeXml(
        format(tick),
      )}</text>`,
    );
  }

  if (opts.xAxis?.label) {
    body.push(
      `<text class="stdlib-chart-axis-label" x="${fmt((plotLeft + plotRight) / 2)}" y="${fmt(
        rowsBottom + AXIS_HEIGHT - 2,
      )}" text-anchor="middle">${escapeXml(opts.xAxis.label)}</text>`,
    );
  }

  if (showLegend) {
    body.push('<g class="stdlib-chart-legend">');
    let x = plotLeft;
    const y = height - 9;
    for (const [index, state] of (opts.states ?? []).entries()) {
      const label = state.label ?? state.state;
      body.push(
        `<rect ${seriesPaint(state.color, index)} x="${fmt(x)}" y="${y - 8}" width="8" height="8" rx="2"/>`,
        `<text class="stdlib-chart-heatmap-label" x="${fmt(x + 12)}" y="${y}" text-anchor="start">${escapeXml(label)}</text>`,
      );
      x += 20 + label.length * 6.2;
    }
    body.push("</g>");
  }

  return svgRoot({ width, height, className: opts.className }, body.join(""));
};
