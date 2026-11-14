import { chartTextWidth, headerHeight, wrapLabel } from "../../content/chart-bar";
import { chartMessages } from "../../content/chart-message-catalog";
import { barPercent } from "./bar-labels";
import type { ChartDatum } from "./types";

export type FunnelOptions = {
  data: { label: string; value: number | null }[];
  valueFormat?: (value: number) => string;
  locale?: string;
  title?: string;
  subtitle?: string;
  className?: string;
};

/** Ratios use the original start/previous observation. Geometry fits the largest observed step, including rises. */
export function funnelLayout(spec: FunnelOptions, size = { width: 480, height: 280 }) {
  if (spec.data.some((d) => d.value !== null && (!Number.isFinite(d.value) || d.value < 0)))
    throw new RangeError("Funnel values must be finite and nonnegative, or null");
  const unit = size.width / 296;
  const numbers = new Intl.NumberFormat(spec.locale ?? "en");
  const format = spec.valueFormat ?? ((v: number) => numbers.format(v));
  const labels = chartMessages.resolve([spec.locale ?? "en"]).t;
  const percent = barPercent(spec.locale);
  const share = (value: number | null, denominator: number | null | undefined) =>
    value === null || denominator == null || denominator === 0 ? null : value / denominator;
  const left = Math.min(96 * unit, size.width * 0.3);
  const right = Math.max(104 * unit, ...spec.data.map((d) => (d.value === null ? 0 : (chartTextWidth(format(d.value)) + 8) * unit)));
  const plot = Math.max(0, size.width - left - right - 8);
  const center = left + plot / 2;
  const top = headerHeight(spec);
  const pitch = (size.height - top) / Math.max(1, spec.data.length);
  const height = Math.min(pitch * 0.6, 34);
  const max = Math.max(0, ...spec.data.map((d) => d.value ?? 0));
  const steps = spec.data.map((d, index) => {
    const startShare = share(d.value, spec.data[0]?.value);
    const previousShare = index ? share(d.value, spec.data[index - 1]?.value) : null;
    const y = top + index * pitch + (pitch - height) / 2;
    const fields = [
      { key: "value", value: d.value ?? "–", formatted: d.value === null ? "–" : format(d.value) },
      {
        key: "startPercent",
        value: startShare === null ? "–" : startShare * 100,
        formatted: startShare === null ? "–" : percent.format(startShare),
      },
      ...(index
        ? [
            {
              key: "previousPercent",
              value: previousShare === null ? "–" : previousShare * 100,
              formatted: previousShare === null ? "–" : percent.format(previousShare),
            },
          ]
        : []),
    ];
    const datum: ChartDatum = { role: "item", index, label: d.label, anchor: [center, y], values: fields };
    return {
      ...d,
      index,
      center,
      y,
      width: d.value === null || max === 0 ? 0 : (d.value / max) * plot,
      startShare,
      previousShare,
      datum,
      labelLines: wrapLabel(d.label, ((left / unit - 8) * 11) / 12.5, 2).lines,
      valueText: fields[0]!.formatted,
      shareText: `${fields[1]!.formatted} ${labels.chartBarStart}`,
      title: `${d.label} · ${fields[0]!.formatted} · ${labels.chartFields({ key: "startPercent" })}: ${fields[1]!.formatted}${index ? ` · ${labels.chartFields({ key: "previousPercent" })}: ${fields[2]!.formatted}` : ""}`,
    };
  });
  return { ...size, unit, left, right, center, top, pitch, barHeight: height, steps };
}

export type FunnelLayout = ReturnType<typeof funnelLayout>;
