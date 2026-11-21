import { type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Button } from "../actions/Button";
import { useUiMessages } from "../intl/messages";
import { Paper } from "./Paper";

export type PlaceholderAlign = "center" | "left";
export type PlaceholderSurface = "none" | "paper";
export type PlaceholderState = "empty" | "no-results" | "no-access" | "loading" | "error";
/** `compact` stacks inside a section, `inline` is one row in a list or sidebar, `panel` fills a work area. */
export type PlaceholderVariant = "compact" | "inline" | "panel";
/** The tone of the round sign; the sentence still says what it means (K8, K10). */
export type PlaceholderTone = "success" | "info" | "warning" | "danger";

export type PlaceholderProps = {
  title?: JSX.Element;
  description?: JSX.Element;
  icon?: string;
  action?: JSX.Element;
  onRetry?: () => void;
  align?: PlaceholderAlign;
  surface?: PlaceholderSurface;
  state?: PlaceholderState;
  variant?: PlaceholderVariant;
  /**
   * Colours the round sign in a state tone, such as `success` with a check for "All done". The title still says it
   * in words. Without an `icon` the tone brings its own: check, info, alert triangle, or alert circle.
   */
  tone?: PlaceholderTone;
  class?: string;
};

const TONE_ICONS: Record<PlaceholderTone, string> = {
  success: "ti ti-check",
  info: "ti ti-info-circle",
  warning: "ti ti-alert-triangle",
  danger: "ti ti-alert-circle",
};

export default function Placeholder(props: PlaceholderProps): JSX.Element {
  const messages = useUiMessages();
  const align = () => props.align ?? "center";
  const state = () => props.state ?? "empty";
  const variant = () => props.variant ?? "compact";
  const icon = () =>
    props.icon ??
    (props.tone && state() !== "loading" && state() !== "error" ? TONE_ICONS[props.tone] : undefined) ??
    (state() === "loading"
      ? "ti ti-loader-2"
      : state() === "error"
        ? "ti ti-alert-circle"
        : state() === "no-results"
          ? "ti ti-search-off"
          : state() === "no-access"
            ? "ti ti-lock"
            : undefined);

  return (
    <Dynamic
      component={props.surface === "paper" ? Paper : "div"}
      class={`k2b-placeholder ${props.class ?? ""}`}
      data-align={align()}
      data-state={state()}
      data-surface={props.surface ?? "none"}
      data-variant={variant()}
      data-tone={props.tone}
      role={state() === "error" ? "alert" : state() === "loading" ? "status" : undefined}
      aria-live={state() === "loading" ? "polite" : undefined}
      aria-busy={state() === "loading" ? "true" : undefined}
    >
      <Show when={icon()}>
        {(iconClass) => (
          // One round sign (K10): a quiet disc for the calm states and an error; loading keeps the same box bare.
          <span class="k2b-placeholder__icon" data-sign={state() === "loading" ? undefined : ""}>
            <i class={iconClass()} aria-hidden="true" />
          </span>
        )}
      </Show>
      <Show when={props.title}>
        <p class="k2b-placeholder__title">{props.title}</p>
      </Show>
      <Show when={props.description}>
        <div class="k2b-placeholder__description">{props.description}</div>
      </Show>
      <Show when={props.action || (state() === "error" && props.onRetry)}>
        <div class="k2b-placeholder__action">
          {props.action}
          <Show when={state() === "error" && props.onRetry}>
            <Button type="button" size="sm" variant="secondary" onClick={() => props.onRetry?.()}>
              {messages().tryAgain}
            </Button>
          </Show>
        </div>
      </Show>
    </Dynamic>
  );
}
