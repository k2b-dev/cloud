import { type JSX, Show } from "solid-js";
import Chart from "../content/Chart";
import type { AccentColor } from "../semantics";
import { type StatGridSize, useStatGridSize, useStatGridSurface } from "./StatGrid";

export type StatCellTone = AccentColor;

export type StatCellAccent = {
  tone: StatCellTone;
  icon: string;
  text?: string;
};

export type StatCellProps = {
  label: string;
  value: string | number | JSX.Element;
  sub?: string;
  valueClass?: string;
  accent?: StatCellAccent;
  href?: string;
  title?: string;
  trend?: readonly number[];
  size?: StatGridSize;
  /**
   * Wraps the label, value and support line instead of truncating them. Use it for a cell whose height nothing
   * reserves, such as one figure on its own; cells compared in a row keep one line each.
   */
  wrap?: boolean;
};

function Body(props: StatCellProps): JSX.Element {
  const gridSize = useStatGridSize();
  const size = () => props.size ?? gridSize;
  const accent = () => props.accent;
  return (
    <>
      <span class="k2b-stat-cell__label" data-size={size()}>
        {props.label}
      </span>
      <span class={`k2b-stat-cell__value ${props.valueClass ?? ""}`} data-size={size()} title={props.title}>
        {props.value}
      </span>
      <Show when={props.trend && props.trend.length > 1}>
        <Chart
          kind="sparkline"
          labels={{ interactiveChart: props.label }}
          class="k2b-stat-cell__trend"
          style={{ height: "32px" }}
          data={Array.from(props.trend ?? [])}
          showLast
          showMinMax
        />
      </Show>
      <Show when={props.sub || accent()}>
        <div class="k2b-stat-cell__support">
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
        </div>
      </Show>
    </>
  );
}

export function StatCell(props: StatCellProps): JSX.Element {
  const gridSize = useStatGridSize();
  const size = () => props.size ?? gridSize;
  const surface = useStatGridSurface();
  return (
    <Show
      when={props.href}
      fallback={
        <div class="k2b-stat-cell" data-size={size()} data-surface={surface} data-wrap={props.wrap || undefined}>
          <Body {...props} />
        </div>
      }
    >
      {(href) => (
        <a
          href={href()}
          class="k2b-stat-cell k2b-stat-cell--link"
          data-size={size()}
          data-surface={surface}
          data-wrap={props.wrap || undefined}
        >
          <i class="ti ti-external-link k2b-stat-cell__link-icon" aria-hidden="true" />
          <Body {...props} />
        </a>
      )}
    </Show>
  );
}

export default StatCell;
