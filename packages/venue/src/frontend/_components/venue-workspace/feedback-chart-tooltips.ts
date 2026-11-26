import type { ChartSelection, ChartTooltipFormatter } from "@k2b/ui";

const numberValue = (selection: ChartSelection, key: string) => {
  const value = selection.datum.values.find((field) => field.key === key)?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

/** A rating average on the 1–5 scale with one decimal, as the average stat and the chart tooltip show it (`4,2/5`). */
export const formatFeedbackRating = (value: number, locale: string) =>
  `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)}/5`;

/**
 * The average-rating line (or a single day's point) plots day slots 1..n on x. The tooltip names the day like the
 * x axis does, the rating like the average stat, and with `counts` how many ratings came that day, so the one chart
 * tells both and no slot number or raw scale value reaches the reader.
 */
export const feedbackRatingTooltip =
  (options: {
    dayLabels: readonly string[];
    label: string;
    locale: string;
    counts?: { label: string; values: readonly number[] };
  }): ChartTooltipFormatter =>
  (selection) => {
    const x = numberValue(selection, "x");
    const y = numberValue(selection, "y");
    const day = x === undefined ? undefined : Math.round(x) - 1;
    const count = day === undefined ? undefined : options.counts?.values[day];
    return {
      title: day === undefined ? undefined : options.dayLabels[day],
      rows: [
        ...(y === undefined ? [] : [{ label: options.label, value: formatFeedbackRating(y, options.locale) }]),
        ...(count === undefined || !options.counts
          ? []
          : [{ label: options.counts.label, value: new Intl.NumberFormat(options.locale, { maximumFractionDigits: 0 }).format(count) }]),
      ],
    };
  };
