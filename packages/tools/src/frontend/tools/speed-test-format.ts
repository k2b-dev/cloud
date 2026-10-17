import type { ChartTooltipFormatter } from "@k2b/ui";

/** One decimal below 10, whole numbers above, in the reader's locale; the large reading and its sparkline share it. */
export const formatSpeedTestReading = (value: number | null, locale: string): string => {
  if (value === null) return "—";
  const digits = value < 10 ? 1 : 0;
  return new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(value);
};

/** A sparkline sample named like its metric, with the unit next to the reading (`Download: 94 Mbps`). */
export const speedTestSparklineTooltip =
  (options: { label: string; unit: string; locale: string }): ChartTooltipFormatter =>
  ({ datum }) => {
    const value = datum.values.find((field) => field.key === "y")?.value;
    return {
      rows:
        typeof value === "number" && Number.isFinite(value)
          ? [{ label: options.label, value: `${formatSpeedTestReading(value, options.locale)} ${options.unit}` }]
          : [],
    };
  };
