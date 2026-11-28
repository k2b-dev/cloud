const UNITS = [
  { unit: "day", ms: 86_400_000 },
  { unit: "hour", ms: 3_600_000 },
  { unit: "minute", ms: 60_000 },
  { unit: "second", ms: 1000 },
] as const;

/**
 * A run's duration in the largest units that say it: "64 ms", "1,4 Sek.", "17 Min. 3 Sek.", "1 Std. 17 Min.", "2 Tg. 3 Std."
 * in the reader's language. A negative or unreadable value is no duration (null), never "-1 ms".
 */
export const runDurationFormatter = (locale: string) => {
  const unit = (name: string, digits = 0) =>
    new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "short", maximumFractionDigits: digits });
  const ms = unit("millisecond");
  const seconds = unit("second", 1);
  const whole = Object.fromEntries(UNITS.map((entry) => [entry.unit, unit(entry.unit)])) as Record<
    (typeof UNITS)[number]["unit"],
    Intl.NumberFormat
  >;
  return (value: number): string | null => {
    if (!Number.isFinite(value) || value < 0) return null;
    if (Math.round(value) < 1000) return ms.format(Math.round(value));
    if (value < 60_000) return seconds.format(value / 1000);
    const index = UNITS.findIndex((entry) => value >= entry.ms);
    const big = UNITS[index]!;
    const small = UNITS[index + 1]!;
    let count = Math.floor(value / big.ms);
    let rest = Math.round((value - count * big.ms) / small.ms);
    if (rest * small.ms >= big.ms) {
      count += 1;
      rest = 0;
    }
    return rest > 0 ? `${whole[big.unit].format(count)} ${whole[small.unit].format(rest)}` : whole[big.unit].format(count);
  };
};
