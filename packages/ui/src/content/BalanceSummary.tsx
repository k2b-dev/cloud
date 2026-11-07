import type { JSX } from "solid-js";
import { useLocale } from "../intl/locale";
import { useBalanceSummaryMessages } from "./balance-summary-messages";
import { FlowAmount } from "./FlowAmount";

export type BalanceSummaryProps = {
  /** The balance at the start of the period. */
  start: number;
  /** Money that came in during the period, as an amount (the sign is ignored). */
  in: number;
  /** Money that went out during the period, as an amount (the sign is ignored). */
  out: number;
  /** ISO 4217 currency code, e.g. `"EUR"`. */
  currency: string;
  /** Explicit locale override; defaults to the inherited render locale. */
  locale?: string;
  /** Fixed fraction digits. Defaults to 0. */
  decimals?: number;
  /** Replaces the words "Start", "End", "in" and "out". */
  labels?: { start?: string; end?: string; in?: string; out?: string };
  class?: string;
};

const amount = (value: number) => (Number.isFinite(value) ? Math.abs(value) : 0);

/**
 * One line from the start of a period to its end: "Start 18,800 € + ↙ 29,260 € − ↗ 29,520 € = End 18,540 €". In and
 * out show their direction with `FlowAmount`; start and end are balances and keep their sign.
 */
export function BalanceSummary(props: BalanceSummaryProps): JSX.Element {
  const locale = useLocale();
  const t = useBalanceSummaryMessages();
  const lang = () => props.locale ?? locale();
  const decimals = () => props.decimals ?? 0;
  const balance = (value: number) =>
    new Intl.NumberFormat(lang(), {
      style: "currency",
      currency: props.currency,
      minimumFractionDigits: decimals(),
      maximumFractionDigits: decimals(),
    }).format(value === 0 ? 0 : value);
  const start = () => (Number.isFinite(props.start) ? props.start : 0);
  const end = () => start() + amount(props.in) - amount(props.out);
  return (
    <p class={props.class ? `k2b-balance ${props.class}` : "k2b-balance"}>
      <span class="k2b-balance__part">
        {props.labels?.start ?? t().start} <b>{balance(start())}</b>
      </span>
      <span class="k2b-balance__op" aria-hidden="true">
        +
      </span>
      <FlowAmount
        value={amount(props.in) || 0}
        currency={props.currency}
        locale={lang()}
        decimals={decimals()}
        labels={{ in: props.labels?.in ?? t().in }}
      />
      <span class="k2b-balance__op" aria-hidden="true">
        −
      </span>
      <FlowAmount
        value={-amount(props.out) || 0}
        currency={props.currency}
        locale={lang()}
        decimals={decimals()}
        labels={{ out: props.labels?.out ?? t().out }}
      />
      <span class="k2b-balance__op" aria-hidden="true">
        =
      </span>
      <span class="k2b-balance__part">
        {props.labels?.end ?? t().end} <b>{balance(end())}</b>
      </span>
    </p>
  );
}

export default BalanceSummary;
