import { chartDatumSvg, escapeXml, svgRoot } from "@k2b/stdlib";
import { chartTextWidth, wrapLabel } from "../../content/chart-bar";
import { barLabels, barPercent } from "./bar-labels";

export type FunnelOptions = {
  data: { label: string; value: number | null }[];
  valueFormat?: (value: number) => string;
  locale?: string;
  className?: string;
};

/** Ratios use the original start/previous observation. Geometry fits the largest observed step, including rises. */
export function funnelLayout(spec: FunnelOptions, size = { width: 480, height: 280 }) {
  if (spec.data.some((d) => d.value !== null && (!Number.isFinite(d.value) || d.value < 0)))
    throw new RangeError("Funnel values must be finite and nonnegative, or null");
  const unit = size.width / 296;
  const numbers = new Intl.NumberFormat(spec.locale ?? "en");
  const format = spec.valueFormat ?? ((v: number) => numbers.format(v));
  const labels = barLabels(spec.locale);
  const percent = barPercent(spec.locale);
  const share = (value: number | null, denominator: number | null | undefined) =>
    value === null || denominator == null || denominator === 0 ? null : value / denominator;
  const left = Math.min(96 * unit, size.width * 0.3);
  const right = Math.max(104 * unit, ...spec.data.map((d) => (d.value === null ? 0 : (chartTextWidth(format(d.value)) + 8) * unit)));
  const plot = Math.max(0, size.width - left - right - 8);
  const center = left + plot / 2;
  const pitch = size.height / Math.max(1, spec.data.length);
  const height = Math.min(pitch * 0.6, 34);
  const max = Math.max(0, ...spec.data.map((d) => d.value ?? 0));
  const steps = spec.data.map((d, index) => ({
    ...d,
    index,
    center,
    y: index * pitch + (pitch - height) / 2,
    width: d.value === null || max === 0 ? 0 : (d.value / max) * plot,
    startShare: share(d.value, spec.data[0]?.value),
    previousShare: index ? share(d.value, spec.data[index - 1]?.value) : null,
  }));
  return { ...size, unit, format, labels, percent, left, right, center, pitch, barHeight: height, steps };
}

export function renderFunnelSvg(spec: FunnelOptions & { width: number; height: number; inspect?: boolean }) {
  const g = funnelLayout(spec, spec);
  const text = (x: number, y: number, value: string, anchor = "start", cls = "stdlib-chart-tick-label") =>
    `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
  const parts: string[] = [];
  for (const step of g.steps) {
    const next = g.steps[step.index + 1];
    if (next && step.value !== null && next.value !== null)
      parts.push(
        `<polygon points="${g.center - step.width / 2},${step.y + g.barHeight} ${g.center + step.width / 2},${step.y + g.barHeight} ${g.center + next.width / 2},${next.y} ${g.center - next.width / 2},${next.y}" style="fill:color-mix(in srgb,var(--stdlib-chart-c1) 9%,transparent)"/>`,
      );
    const fields = [
      { key: "value", value: step.value ?? "–", formatted: step.value === null ? "–" : g.format(step.value) },
      {
        key: "startPercent",
        value: step.startShare === null ? "–" : step.startShare * 100,
        formatted: step.startShare === null ? "–" : g.percent.format(step.startShare),
      },
      ...(step.index
        ? [
            {
              key: "previousPercent",
              value: step.previousShare === null ? "–" : step.previousShare * 100,
              formatted: step.previousShare === null ? "–" : g.percent.format(step.previousShare),
            },
          ]
        : []),
    ];
    const marks = `<rect class="k2b-chart-category-band" x="0" y="${step.index * g.pitch}" width="${g.width}" height="${g.pitch}" rx="6"/>${step.value === null ? "" : `<rect class="stdlib-chart-bar" x="${g.center - step.width / 2}" y="${step.y}" width="${step.width}" height="${g.barHeight}" rx="4" style="fill:color-mix(in srgb,var(--stdlib-chart-c1) ${Math.max(30, 100 - step.index * 14)}%,var(--k2b-surface));stroke:none"/>`}`;
    parts.push(
      chartDatumSvg(
        marks,
        { role: "item", index: step.index, label: step.label, anchor: [g.center, step.y], values: fields },
        spec.inspect ?? false,
      ).replace(
        /<title>[\s\S]*?<\/title>/,
        `<title>${escapeXml(`${step.label} · ${fields[0]!.formatted} · ${g.labels.startShare}: ${fields[1]!.formatted}${step.index ? ` · ${g.labels.previousShare}: ${fields[2]!.formatted}` : ""}`)}</title>`,
      ),
    );
    const lines = wrapLabel(step.label, ((g.left / g.unit - 8) * 11) / 12.5, 2).lines;
    lines.forEach((line, i) => parts.push(text(0, step.y + g.barHeight / 2 + 4 + (lines.length > 1 ? (i === 0 ? -6.5 : 6.5) : 0), line)));
    parts.push(text(g.width, step.y + g.barHeight / 2 + (step.index ? -2 : 4), fields[0]!.formatted, "end", "stdlib-chart-bar-value"));
    if (step.index) parts.push(text(g.width, step.y + g.barHeight / 2 + 12, `${fields[1]!.formatted} ${g.labels.start}`, "end"));
  }
  return svgRoot({ ...spec, className: [spec.className, "k2b-chart-funnel"].filter(Boolean).join(" ") }, parts.join("")).replace(
    "<svg ",
    '<svg data-bar-layout="rows" data-category-inspection="true" ',
  );
}
