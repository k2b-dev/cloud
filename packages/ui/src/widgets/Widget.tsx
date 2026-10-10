import { type JSX, Show } from "solid-js";
import { Paper } from "../surfaces/Paper";

/**
 * `standard` is 25rem high and `compact` 14rem; `fill` takes the height its container gives it, such as a grid cell,
 * and `content` has no fixed height. Every size except `content` scrolls body content taller than itself.
 */
export type WidgetSize = "content" | "compact" | "standard" | "fill";

export type WidgetProps = {
  title: string;
  icon?: string;
  href?: string;
  meta?: string;
  size?: WidgetSize;
  children: JSX.Element;
};

function Header(props: WidgetProps): JSX.Element {
  return (
    <>
      <Show when={props.icon}>
        {(icon) => (
          <span class="k2b-widget__icon">
            <i class={icon()} aria-hidden="true" />
          </span>
        )}
      </Show>
      <span class="k2b-widget__heading">
        <span class="k2b-widget__title">{props.title}</span>
        <Show when={props.meta}>{(meta) => <span class="k2b-widget__meta">{meta()}</span>}</Show>
      </span>
      <Show when={props.href}>
        <i class="ti ti-chevron-right k2b-widget__chevron" aria-hidden="true" />
      </Show>
    </>
  );
}

export function Widget(props: WidgetProps): JSX.Element {
  return (
    <Paper class="k2b-widget" data-size={props.size ?? "standard"}>
      <Show
        when={props.href}
        fallback={
          <div class="k2b-widget__header">
            <Header {...props} />
          </div>
        }
      >
        {(href) => (
          <a href={href()} class="k2b-widget__header">
            <Header {...props} />
          </a>
        )}
      </Show>
      <div class="k2b-widget__body">{props.children}</div>
    </Paper>
  );
}

export default Widget;
