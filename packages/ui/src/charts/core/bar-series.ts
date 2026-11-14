import type { BarChartOptions, SeriesBarLayout } from "../../content/chart-bar";
import { dotStyle, fmt, headerHeight, renderHeader, tickFormat, wrapLabel } from "./bar-common";
import { visibleCategoryLabels } from "./bar-labels";
import { chartDatumSvg, escapeXml, svgRoot } from "./svg-common";

/** Draw prepared series geometry without importing any bar layout or data-only renderer. */
export const renderSeriesBarLayoutSvg = (
  opts: BarChartOptions & { width: number; height: number; inspect?: boolean },
  g: SeriesBarLayout,
  matrixMarks?: (column: SeriesBarLayout["columns"][number]) => string,
) => {
  const parts = [renderHeader(opts, opts.width)];
  const change = new Intl.NumberFormat(opts.locale ?? "en", { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" });
  const text = (x: number, y: number, value: string, cls = "stdlib-chart-tick-label", anchor = "start", extra = "") =>
    `<text class="${cls}" x="${fmt(x)}" y="${fmt(y)}" text-anchor="${anchor}" ${extra}>${escapeXml(value)}</text>`;
  if (g.legend)
    g.legendLayout.items.forEach((entry, i) => {
      const y = headerHeight(opts) + entry.y;
      const x = entry.x;
      parts.push(
        `<rect class="stdlib-chart-series-${i < (opts.series?.length ?? 0) ? i % 8 : 0}" x="${x}" y="${y - 8}" width="${8 * g.units}" height="8" ${i >= (opts.series?.length ?? 0) ? 'style="fill:none;stroke:var(--stdlib-chart-c1);"' : g.dot ? `style="${dotStyle(i, g.entries.length)};stroke:none"` : ""}/>`,
      );
      if (i >= (opts.series?.length ?? 0))
        parts.push(
          `<path d="M ${x} ${y - 4} l ${4 * g.units} -4 M ${x + 2 * g.units} ${y} l ${6 * g.units} -6 M ${x + 6 * g.units} ${y} l ${2 * g.units} -2" fill="none" stroke="var(--stdlib-chart-c1,#3b82f6)" stroke-width="1"/>`,
        );
      const label = wrapLabel(entry.label, Math.max(8, entry.labelWidth), 1).lines[0] ?? entry.label;
      const value = escapeXml(entry.total === null ? "–" : g.format(entry.total));
      // One text run keeps the value six CSS pixels after its label even when the SVG stretches.
      parts.push(
        `<text x="${fmt(x + 14 * g.units)}" y="${fmt(y)}"><tspan class="stdlib-chart-tick-label">${escapeXml(label)}</tspan><tspan class="stdlib-chart-bar-value" dx="6" data-chart-legend-value data-field="${i < (opts.series?.length ?? 0) ? `series:${i}` : "previous"}" data-default="${value}">${value}</tspan></text>`,
      );
    });
  if (g.legend && g.legendLayout.hidden)
    parts.push(text(0, headerHeight(opts) + g.legendLayout.height - 8, `+${g.legendLayout.hidden}`, "stdlib-chart-tick-label"));
  if (opts.yAxis?.label) parts.push(text(0, g.top - 6, opts.yAxis.label, "stdlib-chart-axis-label"));
  for (const tick of g.scale.ticks) {
    parts.push(`<line class="stdlib-chart-grid" x1="${g.left}" x2="${g.right}" y1="${g.y(tick)}" y2="${g.y(tick)}"/>`);
    parts.push(
      text(g.left - 6 * g.units, g.y(tick) + 4, opts.normalize ? `${Math.round(tick * 100)}%` : tickFormat(opts)(tick), undefined, "end"),
    );
  }
  parts.push(`<line class="stdlib-chart-axis" x1="${g.left}" x2="${g.right}" y1="${g.bottom}" y2="${g.bottom}"/>`);
  const visibleLabels = visibleCategoryLabels(
    g.columns.map((c) => c.label),
    g.left,
    g.slot,
    opts.width,
    g.units,
  );
  for (const column of g.columns) {
    const fields = column.current.map((v, i) => ({
      key: `series:${i}`,
      value: v.raw === null || !Number.isFinite(v.raw) ? "–" : v.raw!,
      formatted: v.raw === null || !Number.isFinite(v.raw) ? "–" : g.format(v.raw!),
    }));
    if (opts.compare) {
      const previous = column.previous;
      fields.push({
        key: "previous",
        value: previous ?? "–",
        formatted: previous === null || !Number.isFinite(previous) ? "–" : g.format(previous!),
      });
      const current = column.current[0]?.raw;
      const delta =
        current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous) ? null : current - previous;
      fields.push({
        key: "delta",
        value: delta ?? "–",
        formatted: delta === null || previous === 0 ? "–" : change.format(delta / Math.abs(previous!)),
      });
    } else if (opts.layout === "stacked" || g.dot) {
      if (!g.dot) fields.reverse();
      fields.push({
        key: "total",
        value: g.dot?.total ?? column.total ?? "–",
        formatted: g.dot ? g.format(g.dot.total) : column.total === null ? "–" : g.format(column.total),
      });
    }
    let marks = `<rect class="k2b-chart-category-band" fill="none" pointer-events="all" x="${column.center - g.slot / 2}" y="${g.top}" width="${g.slot}" height="${Math.max(0, g.bottom - g.top)}" rx="6"/>`;
    const bar = (value: number, base: number, x: number, width: number, color: number, previous = false) => {
      const y0 = g.y(g.scale.log ? g.scale.domain[0] : base),
        y1 = g.y(base + value);
      const rect = `<rect class="stdlib-chart-bar stdlib-chart-series-${color % 8}" x="${fmt(x)}" y="${fmt(Math.min(y0, y1))}" width="${fmt(Math.max(0, width))}" height="${fmt(Math.abs(y0 - y1))}" rx="3"/>`;
      if (!previous) return rect;
      // Inline strokes avoid document-global SVG pattern IDs, including duplicate charts during SSR.
      const lines: string[] = [];
      for (let d = -Math.abs(y0 - y1); d < width; d += 6) {
        const lo = Math.max(0, -d),
          hi = Math.min(Math.abs(y0 - y1), width - d);
        if (hi > lo)
          lines.push(
            `<line x1="${x + d + lo}" y1="${Math.max(y0, y1) - lo}" x2="${x + d + hi}" y2="${Math.max(y0, y1) - hi}" stroke="var(--stdlib-chart-c1,#3b82f6)" stroke-width="1.5"/>`,
          );
      }
      return `<g class="k2b-chart-previous">${rect.replace("/>", ' style="fill:var(--stdlib-chart-c1,#3b82f6);fill-opacity:.14" stroke="var(--stdlib-chart-c1,#3b82f6)" stroke-width="1"/>')}${lines.join("")}</g>`;
    };
    if (g.dot) {
      marks += matrixMarks?.(column) ?? "";
    } else if (opts.compare) {
      const bw = Math.min(g.slot * 0.32, 26);
      const gap = Math.min(1.5, g.slot * 0.08);
      if (column.previous !== null && Number.isFinite(column.previous) && (!g.scale.log || column.previous! > 0))
        marks += bar(column.previous!, 0, column.center - bw - gap, bw, 0, true);
      const value = column.current[0]?.value;
      if (value != null && (!g.scale.log || value > 0)) marks += bar(value, 0, column.center + gap, bw, 0);
    } else
      column.current.forEach((v) => {
        if (v.value === null || (g.scale.log && v.value <= 0)) return;
        const stacked = opts.layout === "stacked";
        const bw = stacked ? Math.min(g.slot * 0.56, 40) : Math.min((g.slot * 0.8) / g.entries.length, 22);
        const gap = bw / g.units > 4 ? 2 : 0;
        const x = stacked ? column.center - bw / 2 : column.center - (g.entries.length * bw) / 2 + v.seriesIndex * bw + gap / 2;
        const segment = bar(v.value, v.base, x, stacked ? bw : bw - gap, v.seriesIndex);
        if (
          stacked &&
          v.value > 0 &&
          column.current.some((next) => next.seriesIndex > v.seriesIndex && next.value !== null && next.value > 0)
        ) {
          const fullHeight = Math.abs(g.y(v.base) - g.y(v.base + v.value));
          const gap = Math.min(1.5, fullHeight / 2);
          marks += segment
            .replace(/y="[^"]*"/, `y="${g.y(v.base + v.value) + gap}"`)
            .replace(/height="[^"]*"/, `height="${fullHeight - gap}"`);
        } else marks += segment;
      });
    parts.push(
      chartDatumSvg(
        marks,
        { role: "item", index: column.index, label: column.label, anchor: [column.center, g.top], values: fields },
        opts.inspect ?? false,
        [
          column.label,
          ...fields.map(
            (field) =>
              `${field.key.startsWith("series:") ? opts.series![Number(field.key.slice(7))]!.label : field.key === "previous" ? opts.compare!.label : field.key === "delta" ? g.labels.delta : g.labels.total}: ${field.formatted}`,
          ),
        ].join(" · "),
      ),
    );
    if (visibleLabels.has(column.index))
      parts.push(text(column.center, g.bottom, column.label, "stdlib-chart-tick-label stdlib-chart-category-label", "middle", 'dy="16"'));
  }
  for (const ref of opts.references ?? [])
    if ((ref.axis ?? "y") === "y" && Number.isFinite(ref.value) && ref.value >= g.scale.domain[0] && ref.value <= g.scale.domain[1]) {
      parts.push(`<line class="stdlib-chart-reference" x1="${g.left}" x2="${g.right}" y1="${g.y(ref.value)}" y2="${g.y(ref.value)}"/>`);
      if (ref.label) parts.push(text(g.right, g.y(ref.value) - 4, ref.label, "stdlib-chart-reference-label", "end"));
    }
  if (opts.xAxis?.label) parts.push(text((g.left + g.right) / 2, opts.height - 2, opts.xAxis.label, "stdlib-chart-axis-label", "middle"));
  return svgRoot(opts, parts.join("")).replace("<svg ", '<svg data-bar-layout="columns" ');
};
