import { type ChartOptions, chartDatumSvg, escapeXml, niceStep, renderHeader, svgRoot } from "./svg";
import { chartTextWidth, fitChartText } from "./text";
export type ParetoOptions = ChartOptions & {
  labels: [string, string];
  data: { label: string; value: number; prev: number; rest?: boolean }[];
  locale?: string;
  format?: (value: number) => string;
  displayWidth?: number;
};
export function paretoLayout(spec: ParetoOptions, size = { width: spec.width ?? 480, height: spec.height ?? 280 }) {
  const width = spec.displayWidth ?? size.width,
    header = renderHeader(width, spec.title, spec.subtitle),
    top = header.height + 24,
    bottom = 48,
    height = Math.max(size.height, spec.data.length * 34 + top + bottom);
  const data = spec.data
    .map((d, index) => {
      if (![d.value, d.prev].every((v) => Number.isFinite(v) && v >= 0))
        throw new RangeError("Pareto values must be finite and nonnegative.");
      return { ...d, index };
    })
    .sort((a, b) => Number(a.rest === true) - Number(b.rest === true) || b.value - a.value);
  const total = data.reduce((s, d) => s + d.value, 0),
    rawMax = Math.max(0, ...data.flatMap((d) => [d.value, d.prev])) || 1;
  const step = niceStep(rawMax, 3),
    roundedMax = Math.ceil(rawMax / step) * step;
  const max = Number.isFinite(roundedMax) && roundedMax > 0 ? roundedMax : rawMax;
  const ticks =
    Number.isFinite(step) && step > 0 && max / step <= 6
      ? Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step)
      : [0, max / 2, max];
  if (!Number.isFinite(total)) throw new RangeError("Pareto total must be finite.");
  const labelWidth = Math.max(0, ...data.map((d) => chartTextWidth(d.label, 12))) + 12;
  const left = Math.min(112, width * 0.4, Math.max(width * 0.25, labelWidth)),
    plot = width - left - 30,
    rowHeight = (height - top - bottom) / Math.max(1, data.length);
  let sum = 0;
  return {
    width,
    height,
    total,
    max,
    ticks,
    left,
    plot,
    rowHeight,
    header,
    top,
    bottom,
    rows: data.map((d, index) => {
      sum += d.value;
      return { ...d, y: top + rowHeight * (index + 0.5), cumulative: total ? sum / total : 0 };
    }),
  };
}
export function renderParetoSvg(spec: ParetoOptions): string {
  const s = paretoLayout(spec);
  const number = spec.format ?? new Intl.NumberFormat(spec.locale ?? "en", { maximumSignificantDigits: 15 }).format;
  const percent = new Intl.NumberFormat(spec.locale ?? "en", { style: "percent", maximumFractionDigits: 1 });
  const changePercent = new Intl.NumberFormat(spec.locale ?? "en", {
    style: "percent",
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  });
  const color = "var(--stdlib-chart-c1,#3b82f6)";
  const body: string[] = [
    s.header.svg
      .replace(/<text class="stdlib-chart-title"/g, '<text fill="var(--k2b-text,#27272a)" font-size="14" class="stdlib-chart-title"')
      .replace(
        /<text class="stdlib-chart-subtitle"/g,
        '<text fill="var(--k2b-text-muted,#45454e)" font-size="11" class="stdlib-chart-subtitle"',
      ),
  ];
  const axisNumber =
    spec.format ??
    new Intl.NumberFormat(spec.locale ?? "en", {
      maximumFractionDigits: 2,
      notation: s.max >= 1e9 || s.max < 0.001 ? "scientific" : "standard",
    }).format;
  for (const tick of s.ticks)
    body.push(
      `<line x1="${s.left + (tick / s.max) * s.plot}" x2="${s.left + (tick / s.max) * s.plot}" y1="${s.top}" y2="${s.height - s.bottom}" stroke="var(--k2b-border,#e4e4e7)" stroke-opacity="0.5" pointer-events="none"/><text x="${s.left + (tick / s.max) * s.plot}" y="${s.top - 8}" text-anchor="middle" font-size="11" fill="var(--k2b-text-muted,#45454e)">${escapeXml(axisNumber(tick))}</text>`,
    );
  let line = `${s.left},${s.top}`;
  for (const row of s.rows) {
    const change = row.prev ? row.value / row.prev - 1 : Number.NaN;
    const bh = Math.min(s.rowHeight * 0.36, 12),
      valueWidth = (row.value / s.max) * s.plot,
      prevWidth = (row.prev / s.max) * s.plot;
    const hatch = `<path class="k2b-chart-pareto-hatch" d="${Array.from({ length: Math.floor(prevWidth / 5) }, (_, i) => `M${s.left + i * 5},${row.y + 1 + bh}l${Math.min(4, prevWidth - i * 5)},-${bh}`).join(" ")}" fill="none" stroke="${color}" stroke-width="1" pointer-events="none"/>`;
    body.push(
      chartDatumSvg(
        `<rect class="k2b-chart-pareto-current" x="${s.left}" y="${row.y - bh - 1}" width="${valueWidth}" height="${bh}" rx="2" fill="${color}" stroke="none"/><rect class="k2b-chart-pareto-previous" x="${s.left}" y="${row.y + 1}" width="${prevWidth}" height="${bh}" rx="2" fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-width="0.8"/>${hatch}<rect class="k2b-chart-category-band" x="0" y="${row.y - s.rowHeight / 2}" width="${s.width}" height="${s.rowHeight}" fill="transparent" pointer-events="none"/><text x="${s.left - 8}" y="${row.y + 4}" text-anchor="end" font-size="12" fill="var(--k2b-text,#27272a)">${escapeXml(fitChartText(row.label, s.left - 12, 12))}</text>`,
        {
          role: "item",
          index: row.index,
          label: row.label,
          anchor: [s.left + valueWidth, row.y],
          grid: [0, s.rows.indexOf(row)],
          values: [
            { key: "value", value: row.value, formatted: number(row.value) },
            { key: "previous", value: row.prev, formatted: number(row.prev) },
            {
              key: "change",
              value: Number.isFinite(change) ? change : 0,
              formatted: Number.isFinite(change) ? changePercent.format(change) : "–",
            },
            { key: "cumulative", value: row.cumulative, formatted: s.total ? percent.format(row.cumulative) : "–" },
          ],
        },
        spec.inspect,
      ),
    );
    line += ` ${s.left + row.cumulative * s.plot},${row.y}`;
  }
  body.push(
    `<line x1="${s.left + 0.8 * s.plot}" x2="${s.left + 0.8 * s.plot}" y1="${s.top}" y2="${s.height - s.bottom}" stroke="var(--k2b-warning-text,#92400e)" stroke-dasharray="5 4"/><text x="${s.left + 0.8 * s.plot + 4}" y="${s.height - s.bottom - 4}" font-size="11" fill="var(--k2b-warning-text,#92400e)">80 %</text><polyline points="${line}" fill="none" stroke="var(--k2b-text-muted,#45454e)" stroke-width="1.5" pointer-events="none"/>`,
  );
  for (let p = 0; p <= 5; p++)
    body.push(
      `<text x="${s.left + (p / 5) * s.plot}" y="${s.height - s.bottom + 17}" text-anchor="middle" font-size="11" fill="var(--k2b-text-muted,#45454e)">${escapeXml(percent.format(p / 5))}</text>`,
    );
  for (const row of s.rows)
    body.push(
      `<circle cx="${s.left + row.cumulative * s.plot}" cy="${row.y}" r="3" fill="var(--k2b-surface,#fff)" stroke="var(--k2b-text-muted,#45454e)" stroke-width="1.5" pointer-events="none"/>`,
    );
  const names = [...spec.labels, (spec.locale ?? "en").startsWith("de") ? "Kumuliert" : "Cumulative"];
  let lx = 0;
  names.forEach((name, index) => {
    const x = lx;
    lx += Math.min(s.width / 3, name.length * 12 + 32);
    const display = fitChartText(name, s.width / 3 - 28, 11);
    body.push(
      `${index === 2 ? `<line x1="${x}" x2="${x + 12}" y1="${s.height - 10}" y2="${s.height - 10}" stroke="var(--k2b-text-muted,#45454e)"/>` : `<rect x="${x}" y="${s.height - 15}" width="10" height="10" rx="2" fill="${color}" fill-opacity="${index === 1 ? 0.2 : 1}"/>${index === 1 ? `<path d="M${x},${s.height - 6}l8,-8" stroke="${color}"/>` : ""}`}<text x="${x + 16}" y="${s.height - 6}" font-size="11" fill="var(--k2b-text-muted,#45454e)">${escapeXml(display)}</text>`,
    );
  });
  return svgRoot({ ...s, className: spec.className }, body.join(""));
}
