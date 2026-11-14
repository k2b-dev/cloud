import { barSeriesLegend, chartTextWidth, headerHeight, wrapLabel } from "../../content/chart-bar";
import { chartMessages } from "../../content/chart-message-catalog";
import { extendDomainToNice, niceStep } from "./svg-renderers";
import type { ChartDatum } from "./types";

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
  const labels = chartMessages.resolve([spec.locale ?? "en"]).t;
  const groups = [...new Set(spec.rows.map((r) => r.group))];
  const totals = spec.rows.map((r) => (r.values.some((v) => v !== null) ? r.values.reduce<number>((sum, v) => sum + (v ?? 0), 0) : null));
  const max = Math.max(0, ...totals.filter((v): v is number => v !== null));
  const scale = extendDomainToNice(0, max || 1, niceStep(max || 1, 4));
  const unit = size.width / 296;
  const left = Math.min(104 * unit, size.width * 0.26);
  const right = size.width - Math.max(52 * unit, ...totals.map((v) => (chartTextWidth(v === null ? "–" : format(v)) + 8) * unit));
  const legendLayout = barSeriesLegend(
    spec.series.map((label, i) => ({ label, data: spec.rows.map((r) => r.values[i] ?? null) })),
    format,
    size.width,
    296,
    70, // One legend budget even when rows grow the initial 280-unit drawing.
  );
  const legend = {
    ...legendLayout,
    items: legendLayout.items.map((entry) => ({
      ...entry,
      valueText: entry.total === null ? "–" : format(entry.total),
      text: wrapLabel(entry.label, entry.labelWidth, 1).lines[0] ?? entry.label,
    })),
  };
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
    let first = true;
    return spec.rows.flatMap((row, index) => {
      if (row.group !== group) return [];
      const groupHeading = first ? group : undefined;
      first = false;
      const center = y + pitch / 2;
      y += pitch;
      let acc = 0;
      const segments = row.values.map((value, seriesIndex) => {
        const start = acc;
        acc += value ?? 0;
        const width = x(acc) - x(start);
        const label = value === null ? "–" : format(value);
        return { value, seriesIndex, x: x(start), width, label, showLabel: width / unit > chartTextWidth(label) + 10 };
      });
      const labelLines = wrapLabel(row.label, Math.max(8, left / unit - 8), 2).lines;
      const total = totals[index]!;
      const valueText = total === null ? "–" : format(total);
      const datum: ChartDatum = {
        role: "item",
        index,
        label: [row.label, row.group].filter(Boolean).join(" · "),
        anchor: [x(total ?? 0) + 4, center],
        values: [
          ...row.values.map((v, i) => ({ key: `series:${i}`, value: v ?? "–", formatted: v === null ? "–" : format(v) })),
          { key: "total", value: total ?? "–", formatted: valueText },
        ],
      };
      const title = [
        row.label,
        row.group,
        ...row.values.map((v, i) => `${spec.series[i]}: ${v === null ? "–" : format(v)}`),
        `${labels.chartFields({ key: "total" })}: ${valueText}`,
      ]
        .filter(Boolean)
        .join(" · ");
      return [
        {
          ...row,
          labelLines,
          groupHeading,
          index,
          center,
          segments,
          total,
          valueText,
          datum,
          title,
          groupY: center - pitch / 2 - groupHeight,
        },
      ];
    });
  });
  return { ...size, header, height: Math.max(size.height, y + 24), top, left, right, rows, groups, pitch, x, scale, format, unit, legend };
}

export type HorizontalBarLayout = ReturnType<typeof hbarLayout>;
