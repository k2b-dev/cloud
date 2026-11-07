import { For, type JSX, Show } from "solid-js";
import { Tooltip } from "../feedback/Tooltip";
import { useLocale } from "../intl/locale";
import { useBudgetMessages } from "./budget-messages";
import { budgetOverrun, budgetRatio, ProgressBar } from "./ProgressBar";

/** One budget: `used` is booked, `expected` comes on top; over the budget is `used + expected - limit`. */
export type BudgetItem = { id?: string; label: string; used: number; expected?: number; limit: number };

export type BudgetListProps = {
  items: readonly BudgetItem[];
  /** ISO 4217 currency code, e.g. `"EUR"`. */
  currency: string;
  /** Explicit locale override; defaults to the inherited render locale. */
  locale?: string;
  /** Fixed fraction digits. Defaults to 0. */
  decimals?: number;
  /** The sentence shown when there is no budget. */
  empty?: string;
  /** Hides the legend under the rows when the host explains the colours elsewhere. */
  legend?: boolean;
  class?: string;
};

/** "near" from 80 % of the budget, "over" beyond it. */
export type BudgetLevel = "ok" | "near" | "over";

/** The figures of one budget row; the share counts booked and expected together. */
export const budgetState = (item: Pick<BudgetItem, "used" | "expected" | "limit">) => {
  const used = Number.isFinite(item.used) ? Math.max(0, item.used) : 0;
  const expected = item.expected !== undefined && Number.isFinite(item.expected) ? Math.max(0, item.expected) : 0;
  const limit = Number.isFinite(item.limit) ? Math.max(0, item.limit) : 0;
  const total = used + expected;
  const over = budgetOverrun(total, limit);
  const ratio = budgetRatio(total, limit);
  // The same float tolerance as the overrun: 0.7 + 0.1 of 1 is exactly 80 %.
  const level: BudgetLevel = over > 0 ? "over" : ratio >= 0.8 - 1e-9 ? "near" : "ok";
  return { used, expected, limit, total, over, free: over > 0 ? 0 : Math.max(0, limit - total), ratio, level };
};

/**
 * Budgets as rows: label and "spent of budget", a bar with booked (solid), expected (hatched) and over the budget
 * (red, with a mark at the limit), and a hint that turns amber from 80 % and red beyond the budget.
 */
export function BudgetList(props: BudgetListProps): JSX.Element {
  const locale = useLocale();
  const t = useBudgetMessages(() => props.locale);
  const money = (value: number) =>
    new Intl.NumberFormat(props.locale ?? locale(), {
      style: "currency",
      currency: props.currency,
      minimumFractionDigits: props.decimals ?? 0,
      maximumFractionDigits: props.decimals ?? 0,
    }).format(value);
  const states = () => props.items.map((item) => ({ item, state: budgetState(item) }));
  const anyExpected = () => states().some(({ state }) => state.expected > 0);
  const anyOver = () => states().some(({ state }) => state.over > 0);
  return (
    <div class={`k2b-budget ${props.class ?? ""}`}>
      <Show when={props.items.length} fallback={<p class="k2b-budget__empty">{props.empty}</p>}>
        <ul class="k2b-budget__list">
          <For each={states()}>
            {({ item, state }) => (
              <li class="k2b-budget__row" data-level={state.level}>
                <Tooltip.Anchor
                  class="k2b-budget__anchor"
                  tabIndex={0}
                  content={
                    <span class="k2b-budget__tip">
                      <b>{item.label}</b>
                      <span>
                        {t().used} <b>{money(state.used)}</b>
                      </span>
                      <Show when={state.expected > 0}>
                        <span>
                          {t().expected} <b>{money(state.expected)}</b>
                        </span>
                      </Show>
                      <span>
                        {t().budget} <b>{money(state.limit)}</b>
                      </span>
                      <span>
                        {state.over > 0 ? t().overBy : t().left} <b>{money(state.over > 0 ? state.over : state.free)}</b>
                      </span>
                    </span>
                  }
                >
                  <span class="k2b-budget__label">{item.label}</span>
                  <span class="k2b-budget__amount">
                    {money(state.total)} <span>{t().of({ limit: money(state.limit) })}</span>
                  </span>
                  <ProgressBar
                    class="k2b-budget__bar"
                    size="sm"
                    label={item.label}
                    segments={[{ value: state.used }, { value: state.expected, pattern: "hatched" }]}
                    limit={state.limit}
                    valueText={t().valueText({
                      used: money(state.used),
                      expected: state.expected > 0 ? money(state.expected) : undefined,
                      limit: money(state.limit),
                    })}
                  />
                  <span class="k2b-budget__hint">
                    <Show when={state.level !== "ok"}>
                      <i class={state.level === "over" ? "ti ti-alert-circle" : "ti ti-alert-triangle"} aria-hidden="true" />
                    </Show>
                    {state.level === "over"
                      ? t().over({ amount: money(state.over) })
                      : state.level === "near"
                        ? t().near({ amount: money(state.free) })
                        : t().free({ amount: money(state.free) })}
                  </span>
                </Tooltip.Anchor>
              </li>
            )}
          </For>
        </ul>
        <Show when={props.legend !== false}>
          <ul class="k2b-budget__legend" aria-hidden="true">
            <li>
              <span class="k2b-budget__swatch" data-pattern="solid" />
              {t().used}
            </li>
            <Show when={anyExpected()}>
              <li>
                <span class="k2b-budget__swatch" data-pattern="hatched" />
                {t().expected}
              </li>
            </Show>
            <Show when={anyOver()}>
              <li>
                <span class="k2b-budget__swatch" data-pattern="over" />
                {t().overLegend}
              </li>
            </Show>
          </ul>
        </Show>
      </Show>
    </div>
  );
}

export default BudgetList;
