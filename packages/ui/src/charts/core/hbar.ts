import { chartDatumSvg, escapeXml, extendDomainToNice, niceStep, svgRoot } from "@k2b/stdlib";
import { barSeriesLegend, chartTextWidth, headerHeight, renderHeader, wrapLabel } from "../../content/chart-bar";

import { categoryLabels } from "./category-labels";

export type HorizontalBarOptions = {
  series: string[];
  rows: { group?: string; label: string; values: (number | null)[] }[];
  valueFormat?: (value: number) => string;
  legend?: boolean;
  title?: string;
  subtitle?: string;
  locale?: string;
  className?: string;
};

/** Stacks start at zero, group headings keep their first-appearance order. */
export function hbarLayout(spec: HorizontalBarOptions, size = { width: 480, height: 280 }) {
  if (
    spec.rows.some(
      (row) => row.values.length !== spec.series.length || row.values.some((v) => v !== null && (!Number.isFinite(v) || v < 0)),
    )
  )
    throw new RangeError("Horizontal bars require aligned nonnegative segment values");
  const format = spec.valueFormat ?? String;
  const groups = [...new Set(spec.rows.map((r) => r.group))];
  const totals = spec.rows.map((r) => (r.values.some((v) => v !== null) ? r.values.reduce<number>((sum, v) => sum + (v ?? 0), 0) : null));
  const max = Math.max(0, ...totals.filter((v): v is number => v !== null));
  const scale = extendDomainToNice(0, max || 1, niceStep(max || 1, 4));
  const unit = size.width / 296;
  const left = Math.min(104 * unit, size.width * 0.26);
  const right = size.width - Math.max(52 * unit, ...totals.map((v) => (chartTextWidth(v === null ? "–" : format(v)) + 8) * unit));
  const legend = barSeriesLegend(
    spec.series.map((label, i) => ({ label, data: spec.rows.map((r) => r.values[i] ?? null) })),
    format,
    size.width,
    296,
    70, // One legend budget even when rows grow the initial 280-unit drawing.
  );
  const header = headerHeight({ title: spec.title, subtitle: spec.subtitle });
  const top = header + (spec.legend === false ? 0 : legend.height);
  const groupHeight = 20;
  const pitch = Math.max(
    32,
    (size.height - top - 24 - groups.filter((g) => g !== undefined).length * groupHeight) / Math.max(1, spec.rows.length),
  );
  const x = (v: number) => left + (v / scale.domain[1]) * (right - left);
  let y = top;
  const rows = groups.flatMap((group) => {
    if (group !== undefined) y += groupHeight;
    return spec.rows.flatMap((row, index) => {
      if (row.group !== group) return [];
      const center = y + pitch / 2;
      y += pitch;
      let acc = 0;
      const segments = row.values.map((value, seriesIndex) => {
        const start = acc;
        acc += value ?? 0;
        return { value, seriesIndex, x: x(start), width: x(acc) - x(start) };
      });
      return [{ ...row, index, center, segments, total: totals[index]!, groupY: center - pitch / 2 - groupHeight }];
    });
  });
  return { ...size, height: Math.max(size.height, y + 24), top, left, right, rows, groups, pitch, x, scale, format, unit, legend };
}

export function renderHbarSvg(spec: HorizontalBarOptions & { width: number; height: number; inspect?: boolean }) {
  const g = hbarLayout(spec, spec);
  const text = (x: number, y: number, value: string, anchor = "start", extra = "") =>
    `<text class="stdlib-chart-tick-label" x="${x}" y="${y}" text-anchor="${anchor}" ${extra}>${escapeXml(value)}</text>`;
  const parts: string[] = [renderHeader({ title: spec.title, subtitle: spec.subtitle }, spec.width)];
  const labels = categoryLabels(spec.locale);
  const header = headerHeight({ title: spec.title, subtitle: spec.subtitle });
  if (spec.legend !== false)
    g.legend.items.forEach((entry, i) => {
      parts.push(
        `<rect class="stdlib-chart-series-${i % 8}" x="${entry.x}" y="${header + entry.y - 8}" width="${8 * g.unit}" height="8"/>`,
        text(entry.x + 14 * g.unit, header + entry.y, wrapLabel(entry.label, entry.labelWidth, 1).lines[0] ?? entry.label),
        text(
          entry.valueX,
          header + entry.y,
          entry.total === null ? "–" : g.format(entry.total),
          "end",
          `data-bar-legend="series:${i}" data-bar-total="${escapeXml(entry.total === null ? "–" : g.format(entry.total))}"`,
        ),
      );
    });
  if (spec.legend !== false && g.legend.hidden) parts.push(text(0, header + g.legend.height - 8, `+${g.legend.hidden}`));
  for (const tick of g.scale.ticks)
    parts.push(
      `<line class="stdlib-chart-grid" x1="${g.x(tick)}" x2="${g.x(tick)}" y1="${g.top}" y2="${g.height - 24}"/>`,
      text(g.x(tick), g.height - 5, g.format(tick), "middle"),
    );
  const seen = new Set<string>();
  for (const row of g.rows) {
    if (row.group !== undefined && !seen.has(row.group)) {
      parts.push(
        text(0, row.groupY + 14, row.group).replace(
          'class="stdlib-chart-tick-label"',
          'class="k2b-chart-group-heading" font-size="11.5" font-weight="600" fill="currentColor"',
        ),
      );
      seen.add(row.group);
    }
    const height = Math.min(26, g.pitch * 0.74);
    const marks = [
      `<rect class="k2b-chart-category-band" fill="none" pointer-events="all" x="0" y="${row.center - g.pitch / 2}" width="${spec.width}" height="${g.pitch}" rx="6"/>`,
    ];
    for (const segment of row.segments) {
      if (segment.value === null) continue;
      marks.push(
        `<rect class="stdlib-chart-bar stdlib-chart-series-${segment.seriesIndex % 8}" x="${segment.x}" y="${row.center - height / 2}" width="${Math.max(segment.width / 2, segment.width - 1.5)}" height="${height}" rx="3" style="fill:var(--stdlib-chart-c${(segment.seriesIndex % 8) + 1},#3b82f6);fill-opacity:.18;stroke:none"/>`,
      );
      const label = g.format(segment.value);
      if (segment.width / g.unit > chartTextWidth(label) + 10)
        marks.push(
          text(segment.x + segment.width / 2, row.center + 4, label, "middle").replace(
            'class="stdlib-chart-tick-label"',
            'class="k2b-chart-segment-value" font-size="11" font-weight="500" fill="currentColor"',
          ),
        );
    }
    parts.push(
      chartDatumSvg(
        marks.join(""),
        {
          role: "item",
          index: row.index,
          label: [row.label, row.group].filter(Boolean).join(" · "),
          anchor: [g.x(row.total ?? 0) + 4, row.center],
          values: [
            ...row.values.map((v, i) => ({ key: `series:${i}`, value: v ?? "–", formatted: v === null ? "–" : g.format(v) })),
            { key: "total", value: row.total ?? "–", formatted: row.total === null ? "–" : g.format(row.total) },
          ],
        },
        spec.inspect ?? false,
      ).replace(
        /<title>[\s\S]*?<\/title>/,
        `<title>${escapeXml([row.label, row.group, ...row.values.map((v, i) => `${spec.series[i]}: ${v === null ? "–" : g.format(v)}`), `${labels.total}: ${row.total === null ? "–" : g.format(row.total)}`].filter(Boolean).join(" · "))}</title>`,
      ),
    );
    const label = wrapLabel(row.label, Math.max(8, g.left / g.unit - 8), 2);
    label.lines.forEach((line, i) =>
      parts.push(text(g.left - 8 * g.unit, row.center + 4 + (label.lines.length > 1 ? (i === 0 ? -6.5 : 6.5) : 0), line, "end")),
    );
    parts.push(text(g.x(row.total ?? 0) + 6 * g.unit, row.center + 4, row.total === null ? "–" : g.format(row.total)));
  }
  return svgRoot({ ...spec, height: g.height }, parts.join("")).replace("<svg ", '<svg data-bar-layout="rows" ');
}
