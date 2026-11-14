import { chartTextWidth } from "./bar-common";

export const barPercent = (locale = "en") => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });

export const visibleCategoryLabels = (labels: string[], left: number, slot: number, width: number, units: number) => {
  const labelPx = Math.max(0, ...labels.map((label) => chartTextWidth(label))) + 6;
  const step = Math.max(1, Math.ceil(labelPx / (slot / units)));
  const inside = (i: number) => {
    const half = (chartTextWidth(labels[i]!) * units) / 2,
      center = left + slot * (i + 0.5);
    return center - half >= 0 && center + half <= width;
  };
  const first = Math.max(
    0,
    labels.findIndex((_, i) => inside(i)),
  );
  return new Set(labels.flatMap((_, i) => (i >= first && (i - first) % step === 0 && inside(i) ? [i] : [])));
};
