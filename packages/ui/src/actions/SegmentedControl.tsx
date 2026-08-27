import { createMemo, For, type JSX } from "solid-js";
import { useUiMessages } from "../intl/messages";

export type SegmentOption<T extends string = string> = {
  value: T;
  label: JSX.Element;
  icon?: string;
  disabled?: boolean;
};

export type SegmentedControlProps<T extends string = string> = {
  options: readonly SegmentOption<T>[];
  value: T | (() => T);
  onValueChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
  label?: string;
  size?: "sm" | "md";
  class?: string;
};

/** Controlled radio group with automatic selection during arrow-key navigation. */
export function SegmentedControl<T extends string = string>(props: SegmentedControlProps<T>): JSX.Element {
  const messages = useUiMessages();
  const buttons: HTMLButtonElement[] = [];
  const currentValue = createMemo<T>(() => (typeof props.value === "function" ? props.value() : props.value));
  const enabled = createMemo(() =>
    props.options.map((option, index) => ({ option, index })).filter(({ option }) => !props.disabled && !option.disabled),
  );
  const selectedEnabled = createMemo(() =>
    props.options.some((option) => option.value === currentValue() && !props.disabled && !option.disabled),
  );
  const emit = (value: T) => props.onValueChange(value);
  const select = (index: number) => {
    const option = props.options[index];
    if (!option || props.disabled || option.disabled) return;
    emit(option.value);
    queueMicrotask(() => buttons[index]?.focus());
  };
  const selectRelative = (currentIndex: number, direction: 1 | -1) => {
    const available = enabled();
    if (available.length === 0) return;
    const current = available.findIndex(({ index }) => index === currentIndex);
    const next = available[(current + direction + available.length) % available.length] ?? available[0];
    if (next) select(next.index);
  };
  const edge = (last: boolean) => {
    const available = enabled();
    const next = last ? available.at(-1) : available[0];
    if (next) select(next.index);
  };
  const tabIndex = (index: number, value: T) => {
    if (props.disabled || props.options[index]?.disabled) return -1;
    if (currentValue() === value) return 0;
    return !selectedEnabled() && enabled()[0]?.index === index ? 0 : -1;
  };
  const divider = (index: number, value: T) =>
    index < props.options.length - 1 && currentValue() !== value && currentValue() !== props.options[index + 1]?.value;

  return (
    <div
      class={`k2b-segmented-control ${props.class ?? ""}`}
      data-size={props.size ?? "md"}
      role="radiogroup"
      aria-label={props.ariaLabel ?? props.label ?? messages().options}
      aria-orientation="horizontal"
      aria-disabled={props.disabled ? "true" : undefined}
    >
      <For each={props.options}>
        {(option, index) => (
          <button
            ref={(element) => {
              buttons[index()] = element;
            }}
            type="button"
            role="radio"
            class="k2b-segmented-control__option"
            aria-checked={currentValue() === option.value}
            data-selected={currentValue() === option.value ? "true" : undefined}
            data-divider={divider(index(), option.value) ? "true" : undefined}
            disabled={props.disabled || option.disabled}
            tabIndex={tabIndex(index(), option.value)}
            onClick={() => emit(option.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                selectRelative(index(), 1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                selectRelative(index(), -1);
              } else if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                edge(event.key === "End");
              }
            }}
          >
            {option.icon && <i class={option.icon} aria-hidden="true" />}
            <span>{option.label}</span>
          </button>
        )}
      </For>
    </div>
  );
}

export default SegmentedControl;
