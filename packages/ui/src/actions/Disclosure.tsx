import { createEffect, createSignal, type JSX, Show } from "solid-js";
import type { MaybeAccessor } from "../inputs/field-contract";
import { resolveMaybeAccessor } from "../inputs/field-contract";

export type DisclosureProps = {
  summary: JSX.Element;
  surface?: "paper" | "plain";
  children: JSX.Element;
  value?: MaybeAccessor<boolean>;
  defaultValue?: boolean;
  onValueChange?: (value: boolean) => void;
  icon?: string;
  disabled?: boolean;
  class?: string;
};

/** Native disclosure with the same value/onValueChange vocabulary as other controls. */
export function Disclosure(props: DisclosureProps): JSX.Element {
  const controlled = () => props.value !== undefined;
  const [internal, setInternal] = createSignal(props.defaultValue ?? false);
  const open = () => (controlled() ? Boolean(resolveMaybeAccessor(props.value)) : internal());
  let details: HTMLDetailsElement | undefined;

  createEffect(() => {
    if (details && details.open !== open()) details.open = open();
  });

  return (
    <details
      ref={details}
      class={`k2b-disclosure ${props.class ?? ""}`}
      data-surface={props.surface ?? "paper"}
      open={open()}
      data-disabled={props.disabled ? "true" : undefined}
      onToggle={(event) => {
        if (props.disabled) {
          event.currentTarget.open = open();
          return;
        }
        const next = event.currentTarget.open;
        // A controlled owner may change `value` without user input. Reflecting
        // that value onto <details> emits a native toggle event; it must not be
        // reported back as a second user change.
        if (controlled() && next === open()) return;
        if (!controlled()) setInternal(next);
        props.onValueChange?.(next);
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: summary is the native interactive trigger for details. */}
      <summary aria-disabled={props.disabled ? "true" : undefined} onClick={(event) => props.disabled && event.preventDefault()}>
        <Show when={props.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
        <span>{props.summary}</span>
        <i class="ti ti-chevron-down k2b-disclosure__chevron" aria-hidden="true" />
      </summary>
      <div class="k2b-disclosure__content">{props.children}</div>
    </details>
  );
}

export default Disclosure;
