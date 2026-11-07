import { type JSX, Match, Show, Switch } from "solid-js";
import Chart from "../content/Chart";
import type { ChartTooltipFormatter } from "../content/chart-inspection-core";
import { useLocale } from "../intl/locale";
import type { AccentColor } from "../semantics";
import { DeltaBadge } from "./delta-badge";
import { type StatGridSize, useStatGridSize, useStatGridSurface } from "./StatGrid";
import { useStatCellMessages } from "./stat-cell-messages";

export type StatCellTone = AccentColor;

export type StatCellAccent = {
  tone: StatCellTone;
  icon: string;
  text?: string;
};

/**
 * The change against a comparison period. `unit: "ratio"` (default) reads `0.082` as `+8.2 %`; `"points"` is the
 * difference of two shares in ratio units, so `0.031` reads `+3.1 pts`. Only with `better` does the badge carry a tone
 * and say "better" or "worse"; without it the change stays unrated.
 */
export type StatCellDelta = {
  value: number;
  unit?: "ratio" | "points";
  better?: "up" | "down";
};

/** The value the change compares against, shown under the figure, such as "Last month 44,560". */
export type StatCellCompare = {
  label: string;
  value: string | number;
};

export type StatCellSize = StatGridSize;

export type StatCellProps = {
  label: string;
  /** The figure. `null` shows the empty dash; `sub` then says why. */
  value: string | number | JSX.Element | null;
  sub?: string;
  valueClass?: string;
  /** An icon in a chip before the label, in `tone`. `"in"` and `"out"` are the money colours of `FlowAmount`. */
  icon?: string;
  /** The chip colour of `icon`. Defaults to zinc. */
  tone?: StatCellTone | "in" | "out";
  accent?: StatCellAccent;
  delta?: StatCellDelta;
  compare?: StatCellCompare;
  href?: string;
  title?: string;
  trend?: readonly number[];
  /**
   * Replaces the default trend tooltip in browser code, for example with a period title or a unit.
   * `selection.datum.index` is the source index into `trend`.
   */
  trendTooltip?: ChartTooltipFormatter;
  size?: StatCellSize;
  /**
   * Wraps the label, value and support line instead of truncating them. Use it for a cell whose height nothing
   * reserves, such as one figure on its own; cells compared in a row keep one line each.
   */
  wrap?: boolean;
  /** `"loading"` keeps the tile's size with placeholders; `"error"` says the figure did not load. */
  status?: "loading" | "error";
  /** Offers "Try again" after an error and "Reload" beside `stale`. */
  onRetry?: () => void;
  /** The figure is not current: a short note such as "As of 09:12 · not current" replaces the support line. */
  stale?: string;
};

function Body(props: StatCellProps): JSX.Element {
  const gridSize = useStatGridSize();
  const size = () => props.size ?? gridSize;
  const accent = () => props.accent;
  const locale = useLocale();
  const t = useStatCellMessages();
  const defaultTrendTooltip: ChartTooltipFormatter = ({ datum }) => {
    const y = datum.values.find((field) => field.key === "y")?.value ?? "";
    return {
      rows: [
        { label: props.label, value: typeof y === "number" ? new Intl.NumberFormat(locale(), { maximumFractionDigits: 6 }).format(y) : y },
      ],
    };
  };
  const compareValue = () => {
    const value = props.compare?.value;
    return typeof value === "number" ? new Intl.NumberFormat(locale()).format(value) : value;
  };
  const empty = () => props.value === null || props.value === undefined || props.value === "";
  return (
    <>
      <div class="k2b-stat-cell__head">
        <Show when={props.icon}>
          {(icon) => (
            <span class="k2b-stat-cell__icon k2b-icon-tile" data-tone={props.tone ?? "zinc"} aria-hidden="true">
              <i class={icon()} />
            </span>
          )}
        </Show>
        <span class="k2b-stat-cell__label" data-size={size()}>
          {props.label}
        </span>
      </div>
      <div class="k2b-stat-cell__main">
        <Switch
          fallback={
            <>
              <span
                class={`k2b-stat-cell__value ${props.valueClass ?? ""}`}
                data-size={size()}
                data-empty={empty() || undefined}
                title={props.title}
              >
                {empty() ? "–" : props.value}
              </span>
              <Show when={!empty() && props.delta}>{(delta) => <DeltaBadge delta={delta()} compare={props.compare} />}</Show>
            </>
          }
        >
          <Match when={props.status === "loading"}>
            <span class="k2b-stat-cell__skeleton k2b-skeleton" data-part="value" aria-hidden="true" />
            <span class="k2b-sr-only">{t().loading}</span>
          </Match>
          <Match when={props.status === "error"}>
            <span class="k2b-stat-cell__error">
              <i class="ti ti-alert-circle" aria-hidden="true" />
              {t().notLoaded}
            </span>
          </Match>
        </Switch>
      </div>
      <div class="k2b-stat-cell__support">
        <Switch
          fallback={
            <Show
              when={props.stale}
              fallback={
                <>
                  <Show when={props.compare}>
                    {(compare) => (
                      <span class="k2b-stat-cell__sub">
                        {compare().label} {compareValue()}
                      </span>
                    )}
                  </Show>
                  <Show when={props.sub}>{(sub) => <span class="k2b-stat-cell__sub">{sub()}</span>}</Show>
                  <Show when={accent()}>
                    {(value) => (
                      <Show
                        when={value().text}
                        fallback={<i class={`${value().icon} k2b-stat-cell__accent-icon`} data-tone={value().tone} aria-hidden="true" />}
                      >
                        {(text) => (
                          <span class="k2b-stat-cell__accent" data-tone={value().tone}>
                            <i class={value().icon} aria-hidden="true" />
                            {text()}
                          </span>
                        )}
                      </Show>
                    )}
                  </Show>
                  <Show when={props.trend && props.trend.length > 1}>
                    <Chart
                      kind="sparkline"
                      labels={{ interactiveChart: props.label }}
                      tooltip={props.trendTooltip ?? defaultTrendTooltip}
                      class="k2b-stat-cell__trend"
                      data={Array.from(props.trend ?? [])}
                      showLast
                    />
                  </Show>
                </>
              }
            >
              {(stale) => (
                <>
                  <span class="k2b-stat-cell__stale">
                    <i class="ti ti-clock-exclamation" aria-hidden="true" />
                    {stale()}
                  </span>
                  <Show when={props.onRetry}>
                    {(retry) => (
                      <button type="button" class="k2b-stat-cell__retry" onClick={() => retry()()}>
                        {t().reload}
                      </button>
                    )}
                  </Show>
                </>
              )}
            </Show>
          }
        >
          <Match when={props.status === "loading"}>
            <span class="k2b-stat-cell__skeleton k2b-skeleton" data-part="support" aria-hidden="true" />
          </Match>
          <Match when={props.status === "error"}>
            <Show when={props.onRetry}>
              {(retry) => (
                <button type="button" class="k2b-stat-cell__retry" onClick={() => retry()()}>
                  {t().retry}
                </button>
              )}
            </Show>
          </Match>
        </Switch>
      </div>
    </>
  );
}

/**
 * One key figure as a framed tile: icon and label, the figure with its change, and a support line with the comparison
 * and the trend. Each state (loading, error, stale, empty) keeps the tile's place and size.
 */
export function StatCell(props: StatCellProps): JSX.Element {
  const gridSize = useStatGridSize();
  const size = () => props.size ?? gridSize;
  const surface = useStatGridSurface();
  return (
    <Show
      // A tile that offers a retry is no link: the button must not sit inside it.
      when={props.href && !props.status && !(props.stale && props.onRetry)}
      fallback={
        <div
          class="k2b-stat-cell"
          data-size={size()}
          data-surface={surface}
          data-wrap={props.wrap || undefined}
          data-status={props.status}
          aria-busy={props.status === "loading" || undefined}
        >
          <Body {...props} />
        </div>
      }
    >
      <a
        href={props.href}
        class="k2b-stat-cell k2b-stat-cell--link"
        data-size={size()}
        data-surface={surface}
        data-wrap={props.wrap || undefined}
      >
        <i class="ti ti-external-link k2b-stat-cell__link-icon" aria-hidden="true" />
        <Body {...props} />
      </a>
    </Show>
  );
}

export default StatCell;
