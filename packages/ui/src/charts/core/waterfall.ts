import { chartDatumSvg, escapeXml, niceStep } from "./svg-renderers";
import type { ChartDatum } from "./types";

export type WaterfallOptions = {
  start: { label: string; value: number };
  steps: { label: string; value: number }[];
  end: { label: string };
  title?: string;
  subtitle?: string;
  className?: string;
  /** Formats balances and absolute changes. */
  format?: (value: number) => string;
  locale?: string;
  /** Displayed width in CSS pixels; defaults to the SVG width. Stretching hosts pass their layout width. */
  displayWidth?: number;
};

export type WaterfallBar = { label: string; value: number; from: number; to: number; total: boolean };

/** Totals rest on zero; each change starts at the previous running balance. */
export function waterfallLayout(spec: WaterfallOptions, size: { width: number; height: number }) {
  if (![size.width, size.height].every((value) => Number.isFinite(value) && value > 0)) throw new RangeError("Invalid waterfall size");
  let balance = spec.start.value;
  if (!Number.isFinite(balance)) throw new RangeError("Waterfall values must be finite");
  const bars: WaterfallBar[] = [{ ...spec.start, from: 0, to: balance, total: true }];
  for (const step of spec.steps) {
    const from = balance;
    balance += step.value;
    if (!Number.isFinite(step.value) || !Number.isFinite(balance)) throw new RangeError("Waterfall balances must be finite");
    bars.push({ ...step, from, to: balance, total: false });
  }
  bars.push({ ...spec.end, value: balance, from: 0, to: balance, total: true });
  let lo = 0,
    hi = 0;
  for (const bar of bars) {
    lo = Math.min(lo, bar.from, bar.to);
    hi = Math.max(hi, bar.from, bar.to);
  }
  if (!Number.isFinite(hi - lo)) throw new RangeError("Waterfall range must be finite");
  if (lo === hi) hi = lo + 1;
  const step = niceStep(hi - lo, 5);
  const lower = Math.floor(lo / step) * step;
  const upper = Math.ceil(hi / step) * step;
  if (!(step > 0) || ![step, lower, upper, upper - lower].every(Number.isFinite) || lower >= upper)
    throw new RangeError("Waterfall values cannot form a finite axis; rescale them first");
  // Integer tick indices cannot stall when adjacent floats are large. The five-interval nice step bounds their count.
  const scale = {
    domain: [lower, upper] as [number, number],
    ticks: Array.from({ length: Math.round((upper - lower) / step) + 1 }, (_, i) => lower + i * step),
  };
  const format = spec.format ?? new Intl.NumberFormat(spec.locale ?? "en", { maximumFractionDigits: 2 }).format;
  const displayWidth = spec.displayWidth ?? size.width;
  if (!Number.isFinite(displayWidth) || displayWidth <= 0) throw new RangeError("Invalid waterfall display width");
  const ratio = size.width / displayWidth;
  const left = Math.min(size.width * 0.6, Math.max(48, ...scale.ticks.map((v) => format(v).length * 7 + 12)) * ratio);
  const top = spec.title || spec.subtitle ? 58 : 24;
  const bottom = Math.max(top + 1, size.height - 30);
  const right = size.width - 10;
  const slot = (right - left) / bars.length;
  const project = (value: number) => bottom - ((value - scale.domain[0]) / (scale.domain[1] - scale.domain[0])) * (bottom - top);
  const amount = (bar: WaterfallBar) =>
    `${bar.total ? "" : bar.value > 0 ? "↙ " : bar.value < 0 ? "↗ " : "= "}${format(bar.total ? bar.value : Math.abs(bar.value))}`;
  const datum = (bar: WaterfallBar, index: number, center: number, formattedAmount: string): ChartDatum => ({
    role: "item",
    index,
    label: bar.label,
    anchor: [center, top],
    values: bar.total
      ? [{ key: "balance", value: bar.to, formatted: format(bar.to) }]
      : [
          { key: "before", value: bar.from, formatted: format(bar.from) },
          { key: bar.value > 0 ? "inflow" : bar.value < 0 ? "outflow" : "change", value: bar.value, formatted: formattedAmount },
          { key: "after", value: bar.to, formatted: format(bar.to) },
        ],
  });
  return { bars, balance, scale, left, right, top, bottom, slot, ratio, project, format, amount, datum };
}

export type WaterfallLayout = ReturnType<typeof waterfallLayout>;

const f = (value: number) => String(Math.round(value * 100) / 100);
const text = (x: number, y: number, value: string, anchor = "middle", extra = "") =>
  `<text x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" fill="currentColor" stroke="none" font-family="var(--k2b-font-sans, sans-serif)" font-size="11" ${extra}>${escapeXml(value)}</text>`;

/** Pure SVG, including presentation attributes for PDF and hosts outside .k2b-ui. */
export function renderWaterfallSvg(
  spec: WaterfallOptions & { width: number; height: number; inspect?: boolean },
  responsive = false,
): string {
  return renderWaterfallLayoutSvg(spec, waterfallLayout(spec, spec), responsive);
}

/** Draw the geometry already reserved by a host before its drawing module loads. */
export function renderWaterfallLayoutSvg(
  spec: WaterfallOptions & { width: number; height: number; inspect?: boolean },
  g: WaterfallLayout,
  responsive = false,
): string {
  const parts: string[] = [];
  // The Solid host stretches a stable viewBox. Container queries use its drawn CSS width on the first frame,
  // rather than freezing the labels to the phone fallback or measuring and redrawing after hydration.
  const visibility = (minimumWidth: number) => {
    if (!responsive || minimumWidth <= 0) return "";
    const threshold = f(minimumWidth);
    parts.push(
      `<style>@container (max-width: ${f(minimumWidth - 0.01)}px) { .k2b-waterfall [data-waterfall-min-width="${threshold}"] { display: none; } }</style>`,
    );
    return ` data-waterfall-min-width="${threshold}"`;
  };
  if (spec.title) parts.push(text(spec.width / 2, 16, spec.title));
  if (spec.subtitle) parts.push(text(spec.width / 2, spec.title ? 34 : 16, spec.subtitle));
  parts.push(
    `<line class="stdlib-chart-axis" x1="${f(g.left)}" x2="${f(g.right)}" y1="${f(g.bottom)}" y2="${f(g.bottom)}" stroke="currentColor" stroke-opacity="0.2"/>`,
  );
  parts.push(`<line class="stdlib-chart-axis" x1="${f(g.left)}" x2="${f(g.left)}" y1="${f(g.top)}" y2="${f(g.bottom)}" stroke="none"/>`);
  for (const tick of g.scale.ticks) {
    const y = g.project(tick);
    parts.push(
      `<line x1="${f(g.left)}" x2="${f(g.right)}" y1="${f(y)}" y2="${f(y)}" stroke="currentColor" stroke-opacity="${tick === 0 ? ".25" : ".09"}"/>`,
    );
    parts.push(text(g.left - 8, y + 4, g.format(tick), "end", 'class="stdlib-chart-tick-label"'));
  }
  const cssSlot = g.slot / g.ratio;
  const longest = Math.max(1, ...g.bars.map((b) => Math.min(18, b.label.length))) * 6;
  const stride = Math.max(1, Math.ceil((longest + 8) / Math.max(1, cssSlot)));
  const endLimit = Math.max(1, Math.min(18, Math.floor((g.right - g.left) / g.ratio / 12) - 1));
  const endLength = Math.min(endLimit, spec.end.label.length);
  g.bars.forEach((bar, index) => {
    const center = g.left + (index + 0.5) * g.slot;
    const width = Math.min(56, g.slot * 0.62);
    const top = Math.min(g.project(bar.from), g.project(bar.to));
    const height = Math.abs(g.project(bar.from) - g.project(bar.to));
    const color = bar.total
      ? "color-mix(in srgb, var(--k2b-text-muted, #8b8b93) 55%, transparent)"
      : bar.value > 0
        ? "var(--k2b-flow-in-mark, #0891b2)"
        : bar.value < 0
          ? "var(--k2b-flow-out-mark, #8b5cf6)"
          : "color-mix(in srgb, var(--k2b-text-muted, #8b8b93) 55%, transparent)";
    const amount = g.amount(bar);
    const band = `<rect class="k2b-chart-category-band" x="${f(center - g.slot / 2)}" y="${f(g.top)}" width="${f(g.slot)}" height="${f(g.bottom - g.top)}" fill="currentColor" fill-opacity="0" stroke="none"/>`;
    const mark = `<rect class="k2b-waterfall-bar" x="${f(center - width / 2)}" y="${f(top)}" width="${f(width)}" height="${f(Math.max(height, 1))}" rx="3" fill="${color}" stroke="none"/>`;
    const valueWidth = Math.max((46 * spec.width) / width, ((amount.length * 6 + 8) * spec.width) / g.slot);
    const value =
      responsive || (width / g.ratio >= 46 && amount.length * 6 + 8 <= cssSlot)
        ? text(
            center,
            Math.max(g.top - 8, top - 6),
            amount,
            "middle",
            `class="k2b-waterfall-value" font-weight="600"${visibility(valueWidth)}`,
          ).replace('fill="currentColor"', 'fill="var(--k2b-text-secondary, #52525b)"')
        : "";
    parts.push(chartDatumSvg(band + mark + value, g.datum(bar, index, center, amount), spec.inspect ?? false));
    if (index < g.bars.length - 1)
      parts.push(
        `<line class="k2b-waterfall-connector" x1="${f(center + width / 2)}" x2="${f(center + g.slot - width / 2)}" y1="${f(g.project(bar.to))}" y2="${f(g.project(bar.to))}" stroke="currentColor" stroke-opacity=".3" stroke-dasharray="3 3"/>`,
      );
    const ending = index === g.bars.length - 1;
    const endClearance = (Math.min(18, bar.label.length) * 3 + endLength * 6 + 8) / Math.max(1, g.right - center);
    if (ending || responsive || (index % stride === 0 && (index === 0 || endClearance * g.ratio <= 1))) {
      // Power-of-two subsets keep adjacent labels at least one visible slot apart at every container width.
      let spacing = 1;
      if (index > 0) while (index % (spacing * 2) === 0) spacing *= 2;
      const minimumWidth =
        index === 0 || ending ? 0 : Math.max(((longest + 8) * spec.width) / (g.slot * spacing), endClearance * spec.width);
      const limit = ending
        ? endLimit
        : responsive
          ? 18
          : Math.max(1, Math.floor(Math.min(cssSlot * stride - 8, (2 * Math.min(center, spec.width - center)) / g.ratio) / 6) - 1);
      const label = bar.label.length > limit ? `${bar.label.slice(0, Math.max(0, limit - 1))}…` : bar.label;
      parts.push(
        text(
          ending ? g.right : center,
          g.bottom + 20,
          label,
          ending ? "end" : "middle",
          `class="stdlib-chart-tick-label stdlib-chart-category-label "${visibility(minimumWidth)}`,
        ),
      );
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" class="stdlib-chart k2b-waterfall ${escapeXml(spec.className ?? "")}" width="${spec.width}" height="${spec.height}" viewBox="0 0 ${spec.width} ${spec.height}" aria-hidden="true" focusable="false">${parts.join("")}</svg>`;
}
