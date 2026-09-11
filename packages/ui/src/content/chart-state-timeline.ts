import { chartDatumSvg, computeDomain, escapeXml, extendDomainToNice, mapRange, niceStep, svgRoot } from "@k2b/stdlib";

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
  legend?: boolean;
  interactive?: boolean;
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

const truncate = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, Math.max(1, maxChars - 1))}…`;

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
  const maxLabelChars = Math.max(4, Math.floor((gutter - 18) / 6.3));

  rows.forEach((row, rowIndex) => {
    const y = TOP + rowIndex * ROW_HEIGHT;
    if (y + ROW_HEIGHT > rowsBottom + 1) return;
    const label = truncate(row.label, maxLabelChars);
    const labelBody = `<text class="stdlib-chart-state-label" x="${fmt(plotLeft - 8)}" y="${fmt(
      y + ROW_HEIGHT / 2,
    )}" text-anchor="end" dominant-baseline="middle">${escapeXml(label)}</text>`;
    body.push(interactiveGroup(labelBody, row.href, row.tooltip ?? row.label, row.label));

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
      const color = style?.color ? ` fill="${escapeXml(style.color)}"` : "";
      const rect = `<rect class="stdlib-chart-state-region stdlib-chart-series-${stateIndex % 8}"${color} x="${fmt(
        x,
      )}" y="${fmt(y + 3)}" width="${fmt(Math.max(2, x2 - x))}" height="${ROW_HEIGHT - 6}" rx="3"/>`;
      const stateLabel = style?.label ?? interval.state;
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
                { key: "from", value: intervalFrom, formatted: opts.xAxis?.format?.(intervalFrom) },
                { key: "to", value: intervalTo, formatted: opts.xAxis?.format?.(intervalTo) },
                { key: "duration", value: intervalTo - intervalFrom },
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

  const tickTarget = Math.max(2, Math.min(8, Math.floor((plotRight - plotLeft) / 110)));
  const ticks = extendDomainToNice(viewport[0], viewport[1], niceStep(viewport[1] - viewport[0], tickTarget)).ticks;
  const format = opts.xAxis?.format ?? ((value: number) => fmt(value));
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
      const color = state.color ? ` fill="${escapeXml(state.color)}"` : "";
      const label = state.label ?? state.state;
      body.push(
        `<rect class="stdlib-chart-series-${index % 8}"${color} x="${fmt(x)}" y="${y - 8}" width="8" height="8" rx="2"/>`,
        `<text class="stdlib-chart-heatmap-label" x="${fmt(x + 12)}" y="${y}" text-anchor="start">${escapeXml(label)}</text>`,
      );
      x += 20 + label.length * 6.2;
    }
    body.push("</g>");
  }

  return svgRoot({ width, height, className: opts.className }, body.join(""));
};
