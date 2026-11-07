import { type JSX, splitProps } from "solid-js";
import { useLocale } from "../intl/locale";
import { useFlowAmountMessages } from "./flow-amount-messages";

export type FlowAmountDirection = "in" | "out" | "none";

export type FlowAmountProps = Omit<JSX.HTMLAttributes<HTMLSpanElement>, "children"> & {
  /** Signed amount: positive money comes in, negative goes out, zero moves nothing. */
  value: number;
  /** ISO 4217 currency code, e.g. `"EUR"`. */
  currency: string;
  /** Explicit locale override; defaults to the inherited render locale. */
  locale?: string;
  /** Fixed fraction digits. Defaults to the currency's standard digits. */
  decimals?: number;
  /** The direction words screen readers hear, e.g. `{ in: "Einnahme", out: "Ausgabe" }`. */
  labels?: { in?: string; out?: string };
  /** `"lg"` is the key figure size. */
  size?: "md" | "lg";
};

/** The direction a signed amount moves money; `-0` and non-finite amounts move nothing (non-finite shows "—"). */
export const flowDirection = (value: number): FlowAmountDirection =>
  !Number.isFinite(value) || value === 0 ? "none" : value > 0 ? "in" : "out";

const ICONS: Record<FlowAmountDirection, string> = { in: "ti-arrow-down-left", out: "ti-arrow-up-right", none: "ti-equal" };

/**
 * Money with a direction: incoming is turquoise on a ringed surface with an arrow down-left, outgoing is violet with
 * an arrow up-right, zero is grey with "=". The amount carries no sign; the arrow and, for screen readers, a word say
 * the direction, so colour is never the only signal.
 */
export function FlowAmount(props: FlowAmountProps): JSX.Element {
  const [own, rest] = splitProps(props, ["value", "currency", "locale", "decimals", "labels", "size", "class"]);
  const locale = useLocale();
  const t = useFlowAmountMessages(() => own.locale);
  const valid = () => Number.isFinite(own.value);
  const direction = () => flowDirection(own.value);
  const amount = () => {
    const decimals = own.decimals === undefined ? undefined : Math.min(20, Math.max(0, Math.trunc(own.decimals) || 0));
    return new Intl.NumberFormat(own.locale ?? locale(), {
      style: "currency",
      currency: own.currency,
      ...(decimals === undefined ? {} : { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
    }).format(Math.abs(own.value));
  };
  // A missing or broken amount never reads as a believable zero: it shows a dash and says it is unknown.
  const word = () =>
    !valid()
      ? t().invalid
      : direction() === "in"
        ? (own.labels?.in ?? t().in)
        : direction() === "out"
          ? (own.labels?.out ?? t().out)
          : t().none;
  return (
    <span
      {...rest}
      class={own.class ? `k2b-flow-amount ${own.class}` : "k2b-flow-amount"}
      data-direction={direction()}
      data-size={own.size ?? "md"}
      title={word()}
    >
      <span class="k2b-flow-amount__arrow" aria-hidden="true">
        <i class={`ti ${ICONS[direction()]}`} />
      </span>
      {valid() ? amount() : "—"}
      <span class="k2b-sr-only">, {word()}</span>
    </span>
  );
}

export default FlowAmount;
