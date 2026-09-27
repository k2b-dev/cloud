import { type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Paper } from "./Paper";

export type PlaceholderAlign = "center" | "left";
export type PlaceholderSurface = "none" | "paper";
export type PlaceholderState = "empty" | "loading" | "error";
/** `compact` stacks inside a section, `inline` is one row in a list or sidebar, `panel` fills a work area. */
export type PlaceholderVariant = "compact" | "inline" | "panel";

export type PlaceholderProps = {
  title?: JSX.Element;
  description?: JSX.Element;
  icon?: string;
  action?: JSX.Element;
  align?: PlaceholderAlign;
  surface?: PlaceholderSurface;
  state?: PlaceholderState;
  variant?: PlaceholderVariant;
  class?: string;
};

export default function Placeholder(props: PlaceholderProps): JSX.Element {
  const align = () => props.align ?? "center";
  const state = () => props.state ?? "empty";
  const variant = () => props.variant ?? "compact";
  const icon = () => props.icon ?? (state() === "loading" ? "ti ti-loader-2" : state() === "error" ? "ti ti-alert-circle" : undefined);

  return (
    <Dynamic
      component={props.surface === "paper" ? Paper : "div"}
      class={`k2b-placeholder ${props.class ?? ""}`}
      data-align={align()}
      data-state={state()}
      data-surface={props.surface ?? "none"}
      data-variant={variant()}
      role={state() === "error" ? "alert" : state() === "loading" ? "status" : undefined}
      aria-live={state() === "loading" ? "polite" : undefined}
      aria-busy={state() === "loading" ? "true" : undefined}
    >
      <Show when={icon()}>
        {(iconClass) => (
          <span class="k2b-placeholder__icon">
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
      <Show when={props.action}>
        <div class="k2b-placeholder__action">{props.action}</div>
      </Show>
    </Dynamic>
  );
}
