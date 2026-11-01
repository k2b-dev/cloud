import { For, type JSX } from "solid-js";
import { createFieldMeta, Field, fieldDescribedBy } from "../internal/field";
import { radioKeyTarget } from "../internal/radio-keys";
import type { ValueFieldProps } from "./field-contract";
import { resolveMaybeAccessor } from "./field-contract";

export type IconChoiceOption<T extends string = string> = {
  value: T;
  /** What the icon shows; screen readers and the tooltip use it, so the picture is never the only signal. */
  label: string;
  /** An icon class, such as `ti ti-report`. */
  icon: string;
};

export type IconChoicesProps<T extends string = string> = Omit<ValueFieldProps<T | null>, "onValueChange" | "onValueCommit"> & {
  options: readonly IconChoiceOption<T>[];
  onValueChange?: (value: T) => void;
  onValueCommit?: (value: T) => void;
};

/**
 * A labeled single choice from a few named icons, shown as a row of icon buttons. Use `IconInput` when any icon of the
 * catalogue is allowed.
 */
export function IconChoices<T extends string = string>(props: IconChoicesProps<T>): JSX.Element {
  const meta = createFieldMeta(props.id);
  let group: HTMLDivElement | undefined;
  const value = () => resolveMaybeAccessor(props.value) ?? null;
  const tabStop = (option: IconChoiceOption<T>, index: number) =>
    value() === option.value || (index === 0 && !props.options.some((candidate) => candidate.value === value()));
  const choose = (index: number, focus = false) => {
    const option = props.options[index];
    if (!option || props.disabled) return;
    props.onValueChange?.(option.value);
    props.onValueCommit?.(option.value);
    // The radios in their current DOM order: options may have been reordered since they rendered.
    if (focus) queueMicrotask(() => group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus());
  };
  return (
    <Field
      meta={meta}
      labelFor={false}
      class={props.class}
      label={props.label}
      description={props.description}
      error={props.error}
      required={props.required}
      disabled={props.disabled}
    >
      <div
        class="k2b-icon-choices__group"
        ref={group}
        role="radiogroup"
        aria-label={props.label ? undefined : props["aria-label"]}
        aria-labelledby={props.label ? meta.labelId : undefined}
        aria-describedby={fieldDescribedBy(meta, props)}
        aria-disabled={props.disabled ? "true" : undefined}
      >
        <For each={props.options}>
          {(option, index) => (
            <button
              type="button"
              role="radio"
              class="k2b-icon-choices__option"
              aria-checked={value() === option.value}
              aria-label={option.label}
              title={option.label}
              disabled={props.disabled}
              tabIndex={tabStop(option, index()) ? 0 : -1}
              onClick={() => choose(index())}
              onKeyDown={(event) => {
                const target = radioKeyTarget(event.key, index(), props.options.length);
                if (target === undefined) return;
                event.preventDefault();
                choose(target, true);
              }}
            >
              <i class={option.icon} aria-hidden="true" />
            </button>
          )}
        </For>
      </div>
    </Field>
  );
}
