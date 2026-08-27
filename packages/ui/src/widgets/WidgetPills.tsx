import { text } from "@k2b/stdlib";
import { For, type JSX, Show } from "solid-js";
import { useLocale } from "../intl/locale";
import type { WidgetTone } from "./WidgetHero";

export type WidgetPill = {
  label: string;
  value: string | number;
  tone?: WidgetTone;
  href?: string;
};

export type WidgetPillsProps = {
  pills: readonly WidgetPill[];
  grow?: boolean;
};

function Content(props: { pill: WidgetPill }): JSX.Element {
  const locale = useLocale();
  return (
    <>
      <span class="k2b-widget-pill__label">{props.pill.label}</span>
      <span class="k2b-widget-pill__value">
        {typeof props.pill.value === "number" ? text.pprintNumber(props.pill.value, { locale: locale() }) : props.pill.value}
      </span>
    </>
  );
}

export function WidgetPills(props: WidgetPillsProps): JSX.Element {
  return (
    <div class="k2b-widget-pills" data-grow={props.grow ? "true" : undefined}>
      <For each={props.pills}>
        {(pill) => (
          <Show
            when={pill.href}
            fallback={
              <span class="k2b-widget-pill" data-tone={pill.tone ?? "zinc"}>
                <Content pill={pill} />
              </span>
            }
          >
            {(href) => (
              <a href={href()} class="k2b-widget-pill" data-tone={pill.tone ?? "zinc"}>
                <Content pill={pill} />
              </a>
            )}
          </Show>
        )}
      </For>
    </div>
  );
}

export default WidgetPills;
