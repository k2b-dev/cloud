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
 * x axis does and the rating like the average stat, so no slot number or raw scale value reaches the reader.
 */
export const feedbackRatingTooltip =
  (options: { dayLabels: readonly string[]; label: string; locale: string }): ChartTooltipFormatter =>
  (selection) => {
    const x = numberValue(selection, "x");
    const y = numberValue(selection, "y");
    return {
      title: x === undefined ? undefined : options.dayLabels[Math.round(x) - 1],
      rows: y === undefined ? [] : [{ label: options.label, value: formatFeedbackRating(y, options.locale) }],
    };
  };

/** Ratings per day: the bar's day label as title and a whole-number count under the ratings label. */
export const feedbackCountTooltip =
  (options: { label: string; locale: string }): ChartTooltipFormatter =>
  (selection) => {
    const value = numberValue(selection, "value");
    return {
      title: selection.datum.label,
      rows:
        value === undefined
          ? []
          : [{ label: options.label, value: new Intl.NumberFormat(options.locale, { maximumFractionDigits: 0 }).format(value) }],
    };
  };
