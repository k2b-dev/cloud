import { For, type JSX } from "solid-js";
import { createFieldMeta, Field, fieldDescribedBy } from "../internal/field";
import { radioKeyTarget } from "../internal/radio-keys";
import type { ValueFieldProps } from "./field-contract";
import { resolveMaybeAccessor } from "./field-contract";

export type ColorChoiceOption<T extends string = string> = {
  value: T;
  /** The colour's name; screen readers and the tooltip use it, so colour is never the only signal. */
  label: string;
  /** Any CSS colour. */
  color: string;
};

export type ColorChoicesProps<T extends string = string> = Omit<ValueFieldProps<T | null>, "onValueChange" | "onValueCommit"> & {
  options: readonly ColorChoiceOption<T>[];
  onValueChange?: (value: T) => void;
  onValueCommit?: (value: T) => void;
};

/**
 * A labeled single choice from a fixed palette of named colours, shown as round swatches. Use `ColorInput` when any
 * colour is allowed.
 */
export function ColorChoices<T extends string = string>(props: ColorChoicesProps<T>): JSX.Element {
  const meta = createFieldMeta(props.id);
  let group: HTMLDivElement | undefined;
  const value = () => resolveMaybeAccessor(props.value) ?? null;
  const tabStop = (option: ColorChoiceOption<T>, index: number) =>
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
      class={`k2b-color-choices ${props.class ?? ""}`}
      label={props.label}
      description={props.description}
      error={props.error}
      required={props.required}
      disabled={props.disabled}
    >
      <div
        class="k2b-color-choices__group"
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
              class="k2b-color-choices__swatch"
              style={{ "--k2b-color-choice": option.color }}
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
              <i class="ti ti-check" aria-hidden="true" />
            </button>
          )}
        </For>
      </div>
    </Field>
  );
}
