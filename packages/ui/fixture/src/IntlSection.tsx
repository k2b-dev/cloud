import { dates, text } from "@k2b/stdlib";
import { Format, NumberInput, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";

export const INTL_FIXTURE_INSTANT = "2026-07-28T09:00:00Z";
export const INTL_FIXTURE_BASE = "2026-07-28T11:00:00Z";

/**
 * The values this section must render for a given locale, computed through the
 * same published stdlib helpers the components use. The SSR fixture test and
 * the browser parity test assert against the identical expectation, which
 * proves that a server `LocaleProvider` and the browser `<html lang>` fallback
 * agree across independent island roots.
 */
export const intlFixtureExpected = (locale: string) => ({
  number: text.pprintNumber(1234567.89, { locale, decimals: 2 }),
  currency: text.pprintCurrency(1999.5, "EUR", { locale }),
  percent: text.pprintPercent(0.421, { locale }),
  bytes: text.pprintBytes(1536, { locale }),
  date: dates.formatDate(INTL_FIXTURE_INSTANT, { locale, timeZone: "UTC" }),
  time: dates.formatTime(INTL_FIXTURE_INSTANT, { locale, timeZone: "UTC" }),
  dateTime: dates.formatDateTime(INTL_FIXTURE_INSTANT, { locale, timeZone: "UTC" }),
  relative: dates.formatTimeSpan(INTL_FIXTURE_INSTANT, { locale, base: INTL_FIXTURE_BASE }),
  duration: dates.formatDuration(INTL_FIXTURE_INSTANT, INTL_FIXTURE_BASE, { locale }),
  numberInputValue: String(12.5).replace(
    ".",
    new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === "decimal")?.value ?? ".",
  ),
});

export default function IntlSection() {
  const locale = useLocale();
  const [amount, setAmount] = createSignal<number | null>(12.5);

  return (
    <section style={{ display: "grid", gap: "8px" }} data-testid="intl-section">
      <p>
        Effective locale: <output data-testid="intl-locale">{locale()}</output>
      </p>
      <p>
        <Format.Number value={1234567.89} decimals={2} data-testid="intl-number" /> ·{" "}
        <Format.Currency value={1999.5} currency="EUR" data-testid="intl-currency" /> ·{" "}
        <Format.Percent value={0.421} data-testid="intl-percent" /> · <Format.Bytes value={1536} data-testid="intl-bytes" />
      </p>
      <p>
        <Format.Date value={INTL_FIXTURE_INSTANT} data-testid="intl-date" /> ·{" "}
        <Format.Time value={INTL_FIXTURE_INSTANT} data-testid="intl-time" /> ·{" "}
        <Format.DateTime value={INTL_FIXTURE_INSTANT} data-testid="intl-datetime" /> ·{" "}
        <Format.RelativeTime value={INTL_FIXTURE_INSTANT} base={INTL_FIXTURE_BASE} data-testid="intl-relative" /> ·{" "}
        <Format.Duration from={INTL_FIXTURE_INSTANT} to={INTL_FIXTURE_BASE} data-testid="intl-duration" />
      </p>
      <NumberInput label="Amount" decimalPlaces={1} step={0.1} value={amount} onValueChange={setAmount} />
    </section>
  );
}
