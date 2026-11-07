import { type JSX, Match, Show, Switch } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Button } from "../actions/Button";
import { useChartMessages } from "../content/chart-messages";
import { useUiMessages } from "../intl/messages";
import { Paper } from "../surfaces/Paper";
import type { DashboardWidth } from "./Dashboard";

/**
 * What the host's read shows: its content (`ready`), the first read in flight (`loading`), nothing to show (`empty`),
 * a failed first read (`error`), or content whose refresh failed (`stale`).
 */
export type DashboardFrameState = "ready" | "loading" | "empty" | "error" | "stale";

export type DashboardFrameProps = {
  /**
   * Heading of the frame. Without it the frame is only the surface, for content that brings its own head and states,
   * such as `ChartExplorer` with `inset="1rem"`.
   */
  title?: string;
  /** One line under the title; loading and stale notes take its place, so nothing moves. */
  subtitle?: JSX.Element;
  /** Level of the title heading; defaults to 3. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /** Controls at the right of the head, such as a search field or a grouping chip. */
  tools?: JSX.Element;
  /** Defaults to `ready`. */
  state?: DashboardFrameState;
  /** When the shown content was read, formatted by the host ("09:12"); a stale note names it. */
  asOf?: string;
  /** Try again after a failure; without it a failure has no button. */
  onRetry?: () => void;
  /** The empty sentence, such as "No campaign in this period." */
  empty?: JSX.Element;
  /** Tabler icon of the empty state; defaults to `ti ti-chart-bar-off`. */
  emptyIcon?: string;
  /** An action under the empty sentence, such as "Clear search". */
  emptyAction?: JSX.Element;
  /** Height of the body, a CSS length. Every state keeps it. */
  height?: string;
  /**
   * A hidden copy of the full content that holds the body's height in every state, such as every row of a table. The
   * body then reaches the frame's left, right and bottom edges, like a table that brings its own rows.
   */
  reserve?: JSX.Element;
  /** States as one quiet line instead of a centred message, for short content such as an amount or one bar. */
  compact?: boolean;
  /**
   * Share of a `DashboardSection`'s six columns, like `DashboardPanel`: the frame is the grid cell itself, so it never
   * sits in a second frame. Defaults to a third there; ignored elsewhere.
   */
  width?: DashboardWidth;
  class?: string;
  children?: JSX.Element;
};

/**
 * One framed dashboard panel: title, subtitle, tools and the content the host passes, with loading, empty, failure and
 * stale in the same place and at the same height.
 */
export function DashboardFrame(props: DashboardFrameProps): JSX.Element {
  const ui = useUiMessages();
  const chart = useChartMessages();
  const state = () => props.state ?? "ready";
  const failed = () => state() === "error";
  const shown = () => state() === "ready" || state() === "stale";
  const busy = () => (state() === "loading" ? "true" : undefined);
  const className = () => (props.class ? `k2b-dashboard-frame ${props.class}` : "k2b-dashboard-frame");
  const retryLink = () => (
    <button type="button" class="k2b-dashboard-frame__link" onClick={() => props.onRetry?.()}>
      {ui().tryAgain}
    </button>
  );
  const status = () =>
    state() === "loading"
      ? chart().chartLoading
      : state() === "stale"
        ? [props.asOf ? chart().chartAsOf({ time: props.asOf }) : undefined, chart().chartRefreshFailed].filter(Boolean).join(" · ")
        : props.subtitle;
  const empty = () => props.empty ?? ui().noData;
  return (
    <Show
      when={props.title !== undefined}
      fallback={
        <Paper class={className()} data-width={props.width}>
          {props.children}
        </Paper>
      }
    >
      <Paper class={className()} data-width={props.width}>
        <header class="k2b-dashboard-frame__header">
          <div>
            <Dynamic component={`h${props.headingLevel ?? 3}`}>{props.title}</Dynamic>
            {/* One reserved line and a polite live region: loading and stale replace the subtitle without moving. */}
            <p role="status" class={state() === "stale" ? "k2b-dashboard-frame__stale" : undefined}>
              {status()}
              <Show when={state() === "stale" && props.onRetry}>
                {" · "}
                {retryLink()}
              </Show>
            </p>
          </div>
          <Show when={props.tools !== undefined}>
            <div class="k2b-dashboard-frame__tools">{props.tools}</div>
          </Show>
        </header>
        <Show
          when={props.reserve !== undefined}
          fallback={
            <div class="k2b-dashboard-frame__body" style={props.height ? { height: props.height } : undefined} aria-busy={busy()}>
              <Switch fallback={props.children}>
                <Match when={state() === "loading" && props.compact}>
                  <div class="k2b-dashboard-frame__skeleton" aria-hidden="true">
                    <span />
                    <span />
                  </div>
                </Match>
                <Match when={(failed() || state() === "empty") && props.compact}>
                  <p class="k2b-dashboard-frame__inline-state" role={failed() ? "alert" : undefined}>
                    <i class={failed() ? "ti ti-alert-circle" : (props.emptyIcon ?? "ti ti-chart-bar-off")} aria-hidden="true" />
                    {failed() ? chart().chartLoadFailed : empty()}
                    <Show when={failed() && props.onRetry}>{retryLink()}</Show>
                  </p>
                </Match>
                <Match when={!shown()}>
                  <Message />
                </Match>
              </Switch>
            </div>
          }
        >
          <div class="k2b-dashboard-frame__stack" aria-busy={busy()}>
            {/* The full content, hidden: the body's height in every state. */}
            <div class="k2b-dashboard-frame__reserve" aria-hidden="true" inert>
              {props.reserve}
            </div>
            <Show when={shown()} fallback={<Message />}>
              <div class="k2b-dashboard-frame__content">{props.children}</div>
            </Show>
          </div>
        </Show>
      </Paper>
    </Show>
  );

  function Message(): JSX.Element {
    return (
      <div class="k2b-chart-explorer__state" data-state={state()} role={failed() ? "alert" : undefined}>
        <Show when={state() !== "loading"}>
          <span class="k2b-chart-explorer__state-icon" aria-hidden="true">
            <i class={failed() ? "ti ti-alert-circle" : (props.emptyIcon ?? "ti ti-chart-bar-off")} />
          </span>
        </Show>
        <p>{failed() ? chart().chartLoadFailed : state() === "loading" ? "" : empty()}</p>
        <Show when={failed() && props.onRetry}>
          <Button variant="secondary" size="sm" onClick={() => props.onRetry?.()}>
            <i class="ti ti-refresh" aria-hidden="true" />
            {ui().tryAgain}
          </Button>
        </Show>
        <Show when={state() === "empty"}>{props.emptyAction}</Show>
      </div>
    );
  }
}
