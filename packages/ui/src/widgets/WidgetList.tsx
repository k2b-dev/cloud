import { For, type JSX, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";
import type { WidgetTone } from "./WidgetHero";

export type WidgetListItem = {
  icon?: string;
  iconTone?: WidgetTone;
  label: string;
  sub?: string;
  meta?: string;
  href?: string;
};

export type WidgetListProps = {
  items: readonly WidgetListItem[];
  emptyMessage?: string;
  grow?: boolean;
};

function ItemContent(props: { item: WidgetListItem }): JSX.Element {
  return (
    <>
      <Show when={props.item.icon}>
        {(icon) => <i class={`${icon()} k2b-widget-list__icon`} data-tone={props.item.iconTone} aria-hidden="true" />}
      </Show>
      <div class="k2b-widget-list__copy">
        <span class="k2b-widget-list__label">{props.item.label}</span>
        <Show when={props.item.sub}>{(sub) => <span class="k2b-widget-list__sub">{sub()}</span>}</Show>
      </div>
      <Show when={props.item.meta}>{(meta) => <span class="k2b-widget-list__meta">{meta()}</span>}</Show>
      <Show when={props.item.href}>
        <i class="ti ti-chevron-right k2b-widget-list__chevron" aria-hidden="true" />
      </Show>
    </>
  );
}

export function WidgetList(props: WidgetListProps): JSX.Element {
  const messages = useUiMessages();
  return (
    <Show
      when={props.items.length > 0}
      fallback={
        <div class="k2b-widget-list__empty" data-grow={props.grow ? "true" : undefined}>
          <span>{props.emptyMessage ?? messages().nothingHere}</span>
        </div>
      }
    >
      <div class="k2b-widget-list" data-grow={props.grow ? "true" : undefined}>
        <For each={props.items}>
          {(item) => (
            <Show
              when={item.href}
              fallback={
                <div class="k2b-widget-list__item">
                  <ItemContent item={item} />
                </div>
              }
            >
              {(href) => (
                <a href={href()} class="k2b-widget-list__item">
                  <ItemContent item={item} />
                </a>
              )}
            </Show>
          )}
        </For>
      </div>
    </Show>
  );
}

export default WidgetList;
