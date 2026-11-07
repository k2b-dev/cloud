import { chartDatumSvg, escapeXml, niceStep } from "@k2b/stdlib";

export type AreaOptions = {
  layout: "stacked";
  normalize?: boolean;
  x: (string | number)[];
  series: { label: string; data: (number | null)[] }[];
  title?: string;
  subtitle?: string;
  className?: string;
  legend?: boolean;
  format?: (value: number) => string;
  locale?: string;
  /** Narrowest displayed width in CSS pixels; measured hosts pass their actual width. */
  displayWidth?: number;
};
export type AreaPoint = { index: number; amount: number; share: number; lower: number; upper: number };

/** Missing observations interrupt the entire stack; zero-sum columns have no area or inspected values. */
export function areaLayout(spec: AreaOptions, size: { width: number; height: number }) {
  if (![size.width, size.height].every((v) => Number.isFinite(v) && v > 0)) throw new RangeError("Invalid area size");
  if (spec.x.some((x) => typeof x === "number" && !Number.isFinite(x))) throw new RangeError("Area X values must be finite");
  if (spec.series.some((s) => s.data.length !== spec.x.length)) throw new RangeError("Area series must match x length");
  const totals = spec.x.map((_, i) => {
    let total = 0,
      missing = false;
    for (const series of spec.series) {
      const value = series.data[i];
      if (value === null) {
        missing = true;
        continue;
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        throw new RangeError("Area values must be nonnegative finite numbers or null");
      total += value;
    }
    if (!Number.isFinite(total)) throw new RangeError("Area totals must be finite");
    return missing || total === 0 ? null : total;
  });
  const layers: (AreaPoint | null)[][] = spec.series.map(() => []);
  totals.forEach((total, index) => {
    let lower = 0;
    spec.series.forEach((series, s) => {
      const amount = series.data[index];
      if (total === null || amount === null || amount === undefined) {
        layers[s]!.push(null);
        return;
      }
      const share = amount / total;
      const upper = lower + (spec.normalize ? share : amount);
      layers[s]!.push({ index, amount, share, lower, upper });
      lower = upper;
    });
  });
  let rawMax = 0;
  for (const total of totals) if (total !== null) rawMax = Math.max(rawMax, total);
  const step = spec.normalize ? 0.25 : niceStep(rawMax || 1, 5);
  const max = spec.normalize ? 1 : Math.ceil((rawMax || 1) / step) * step;
  if (!(step > 0) || !Number.isFinite(max)) throw new RangeError("Area values cannot form a finite axis; rescale them first");
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const format = spec.format ?? new Intl.NumberFormat(spec.locale ?? "en", { maximumFractionDigits: 2 }).format;
  const percent = new Intl.NumberFormat(spec.locale ?? "en", { style: "percent", maximumFractionDigits: 1 }).format;
  const axisFormat = spec.normalize ? percent : format;
  const displayWidth = spec.displayWidth ?? 296;
  if (!Number.isFinite(displayWidth) || displayWidth <= 0) throw new RangeError("Invalid area display width");
  const ratio = size.width / displayWidth;
  const left = Math.min(size.width * 0.6, Math.max(44, ...ticks.map((v) => axisFormat(v).length * 7 + 12)) * ratio);
  const right = size.width - 12,
    top = (spec.title || spec.subtitle ? 50 : 16) + (spec.legend === false ? 0 : 40);
  const bottom = Math.max(top + 1, size.height - 30);
  const projectX = (index: number) => (spec.x.length < 2 ? (left + right) / 2 : left + (index / (spec.x.length - 1)) * (right - left));
  const projectY = (value: number) => bottom - (value / max) * (bottom - top);
  return { layers, totals, max, ticks, format, percent, axisFormat, ratio, left, right, top, bottom, projectX, projectY };
}
const f = (value: number) => String(Math.round(value * 100) / 100);
const text = (x: number, y: number, label: string, anchor = "middle", extra = "") =>
  `<text x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" fill="currentColor" stroke="none" font-family="var(--k2b-font-sans, sans-serif)" font-size="11" ${extra}>${escapeXml(label)}</text>`;

export function renderAreaSvg(spec: AreaOptions & { width: number; height: number; inspect?: boolean }): string {
  const g = areaLayout(spec, spec),
    parts: string[] = [];
  if (spec.title) parts.push(text(spec.width / 2, 16, spec.title));
  if (spec.subtitle) parts.push(text(spec.width / 2, spec.title ? 32 : 16, spec.subtitle));
  for (const tick of g.ticks) {
    const y = g.projectY(tick);
    parts.push(
      `<line x1="${f(g.left)}" x2="${f(g.right)}" y1="${f(y)}" y2="${f(y)}" stroke="currentColor" stroke-opacity="${tick === 0 ? 0.25 : 0.09}"/>`,
      text(g.left - 8, y + 4, g.axisFormat(tick), "end", 'class="stdlib-chart-tick-label"'),
    );
  }
  parts.push(
    `<line class="stdlib-chart-axis" x1="${f(g.left)}" x2="${f(g.right)}" y1="${f(g.bottom)}" y2="${f(g.bottom)}" stroke="none"/><line class="stdlib-chart-axis" x1="${f(g.left)}" x2="${f(g.left)}" y1="${f(g.top)}" y2="${f(g.bottom)}" stroke="none"/>`,
  );
  const palette = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#a855f7", "#0891b2", "#db2777", "#65a30d"];
  if (spec.legend !== false) {
    const entries = spec.series.slice(0, 4);
    const columns = 2;
    const cell = spec.width / columns;
    entries.forEach((series, i) => {
      const x = (i % columns) * cell + 4,
        y = g.top - 28 + Math.floor(i / columns) * 17;
      const color = `var(--stdlib-chart-c${(i % 8) + 1}, ${palette[i % 8]})`;
      const point = g.layers[i]?.at(-1);
      const value = point ? (spec.normalize ? g.percent(point.share) : g.format(point.amount)) : "—";
      const room = Math.floor((cell * (1 / g.ratio)) / 6) - 4;
      const showValue = value.length + 3 < room;
      const maxChars = Math.max(1, room - (showValue ? value.length + 1 : 0));
      const label = series.label.length > maxChars ? series.label.slice(0, maxChars - 1) + "…" : series.label;
      const full =
        i === 3 && spec.series.length > 4
          ? spec.series
              .slice(3)
              .map((s) => s.label)
              .join(", ")
          : series.label;
      const shown =
        i === 3 && spec.series.length > 4 ? `+${new Intl.NumberFormat(spec.locale ?? "en").format(spec.series.length - 3)}` : label;
      const valueSvg =
        showValue && !(i === 3 && spec.series.length > 4)
          ? `<tspan dx="6" font-weight="600" data-chart-legend-value data-series-index="${i}" data-field="${spec.normalize ? "percent" : "value"}" data-default="${escapeXml(value)}">${escapeXml(value)}</tspan>`
          : "";
      const labelSvg = text(x + 12, y, shown, "start").replace("</text>", `${valueSvg}</text>`);
      parts.push(
        `<g><title>${escapeXml(full)}</title><rect x="${f(x)}" y="${f(y - 8)}" width="8" height="8" rx="2" fill="${color}" stroke="none"/>${labelSvg}</g>`,
      );
    });
  }
  g.layers.forEach((layer, s) => {
    const color = `var(--stdlib-chart-c${(s % 8) + 1}, ${palette[s % 8]})`;
    let run: AreaPoint[] = [];
    const flush = () => {
      if (!run.length) return;
      const points = [
        ...run.map((p) => `${f(g.projectX(p.index))},${f(g.projectY(p.upper))}`),
        ...run.toReversed().map((p) => `${f(g.projectX(p.index))},${f(g.projectY(p.lower))}`),
      ];
      parts.push(
        `<polygon class="k2b-area-layer stdlib-chart-series-${s % 8}" points="${points.join(" ")}" fill="${color}" fill-opacity=".5" stroke="${color}" stroke-width="1"/>`,
      );
      run = [];
    };
    for (const point of layer) {
      if (point) run.push(point);
      else flush();
    }
    flush();
    layer.forEach((point) => {
      if (!point) return;
      const x = g.projectX(point.index),
        y = g.projectY((point.lower + point.upper) / 2);
      const circle = `<circle class="k2b-area-inspection-point" cx="${f(x)}" cy="${f(y)}" r="3" fill="${color}" opacity="0" stroke="none"/>`;
      parts.push(
        chartDatumSvg(
          circle,
          {
            role: "point",
            index: point.index,
            seriesIndex: s,
            label: spec.series[s]!.label,
            anchor: [x, g.top],
            values: [
              { key: "x", value: spec.x[point.index]! },
              { key: "value", value: point.amount, formatted: g.format(point.amount) },
              { key: "total", value: g.totals[point.index]!, formatted: g.format(g.totals[point.index]!) },
              ...(spec.normalize ? [{ key: "percent", value: point.share * 100, formatted: g.percent(point.share) }] : []),
            ],
          },
          spec.inspect ?? false,
        ),
      );
    });
  });
  const slot = ((g.right - g.left) / Math.max(1, spec.x.length)) * (1 / g.ratio);
  const labelWidth = Math.max(1, ...spec.x.map((x) => Math.min(24, String(x).length))) * 6;
  const stride = Math.max(1, Math.ceil(labelWidth / Math.max(1, slot)));
  spec.x.forEach((value, i) => {
    if (i % stride !== 0) return;
    const label = String(value);
    parts.push(
      text(
        g.projectX(i),
        g.bottom + 20,
        label.length > 24 ? label.slice(0, 23) + "…" : label,
        i === 0 ? "start" : i === spec.x.length - 1 ? "end" : "middle",
        'class="stdlib-chart-tick-label"',
      ),
    );
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" class="stdlib-chart k2b-area ${escapeXml(spec.className ?? "")}" width="${spec.width}" height="${spec.height}" viewBox="0 0 ${spec.width} ${spec.height}" aria-hidden="true" focusable="false">${parts.join("")}</svg>`;
}
