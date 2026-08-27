import { text } from "@k2b/stdlib";
import { type JSX, Show } from "solid-js";
import { useLocale } from "../intl/locale";
import type { WidgetTone } from "./WidgetHero";

export type WidgetStatAccent = {
  tone: WidgetTone;
  icon: string;
  text?: string;
};

export type WidgetStatProps = {
  value: string | number;
  label: string;
  sub?: string;
  valueClass?: string;
  accent?: WidgetStatAccent;
  grow?: boolean;
};

export function WidgetStat(props: WidgetStatProps): JSX.Element {
  const locale = useLocale();
  return (
    <div class="k2b-widget-stat" data-grow={props.grow ? "true" : undefined}>
      <span class="k2b-widget-stat__label">{props.label}</span>
      <span class={`k2b-widget-stat__value ${props.valueClass ?? ""}`}>
        {typeof props.value === "number" ? text.pprintNumber(props.value, { locale: locale() }) : props.value}
      </span>
      <Show when={props.sub || props.accent}>
        <div class="k2b-widget-stat__support">
          <Show when={props.sub}>{(sub) => <span class="k2b-widget-stat__sub">{sub()}</span>}</Show>
          <Show when={props.accent}>
            {(accent) => (
              <Show
                when={accent().text}
                fallback={<i class={`${accent().icon} k2b-widget-stat__accent-icon`} data-tone={accent().tone} aria-hidden="true" />}
              >
                {(text) => (
                  <span class="k2b-widget-stat__accent" data-tone={accent().tone}>
                    <i class={accent().icon} aria-hidden="true" />
                    {text()}
                  </span>
                )}
              </Show>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}

export default WidgetStat;
