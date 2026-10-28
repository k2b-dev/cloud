import { Index, type JSX, Show } from "solid-js";
import { createFieldMeta, Field, fieldDescribedBy } from "../internal/field";
import { radioKeyTarget } from "../internal/radio-keys";
import type { ValueFieldProps } from "./field-contract";
import { resolveMaybeAccessor } from "./field-contract";

export type ChoiceListOption<T extends string = string> = {
  value: T;
  label: string;
  /** One sentence on what the choice means. */
  description?: string;
  /** A quiet tag after the label, such as "Default" for the choice that applies without one. */
  marker?: string;
};

export type ChoiceListProps<T extends string = string> = Omit<ValueFieldProps<T | null>, "onValueChange" | "onValueCommit"> & {
  options: readonly ChoiceListOption<T>[];
  /** The chosen value is being saved: a spinner beside its label, and the group is busy. Choosing again is still possible. */
  busy?: boolean;
  /** Busy spinner's name for screen readers, such as "Saving". */
  busyLabel?: string;
  /** Follow-up controls for the chosen option, shown under it and indented to its text, such as a duration. */
  details?: JSX.Element;
  onValueChange?: (value: T) => void;
  onValueCommit?: (value: T) => void;
};

/**
 * A labeled single choice shown as a short list of rows, each with a radio, a label and one sentence on what it
 * means, for a few choices whose consequences need words. Choosing changes only paint, so no row moves; `details`
 * opens under the chosen row. Use `ChoiceChips` for quick picks without explanation, `RichSelect` for longer lists
 * in a dropdown, and `ChoiceTiles` when a preview decides.
 */
export function ChoiceList<T extends string = string>(props: ChoiceListProps<T>): JSX.Element {
  const meta = createFieldMeta(props.id);
  let group: HTMLDivElement | undefined;
  const value = () => resolveMaybeAccessor(props.value) ?? null;
  const tabStop = (option: ChoiceListOption<T>, index: number) =>
    value() === option.value || (index === 0 && !props.options.some((candidate) => candidate.value === value()));
  const choose = (index: number, focus = false) => {
    const option = props.options[index];
    if (!option || props.disabled) return;
    props.onValueChange?.(option.value);
    props.onValueCommit?.(option.value);
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
        class="k2b-choice-list"
        ref={group}
        role="radiogroup"
        aria-label={props.label ? undefined : props["aria-label"]}
        aria-labelledby={props.label ? meta.labelId : undefined}
        aria-describedby={fieldDescribedBy(meta, props)}
        aria-disabled={props.disabled ? "true" : undefined}
        aria-busy={props.busy ? "true" : undefined}
      >
        {/* Rows stay by position, so options rebuilt with new objects keep their buttons and the focus on them. */}
        <Index each={props.options}>
          {(option, index) => {
            const checked = () => value() === option().value;
            const descriptionId = `${meta.controlId}-option-${index}`;
            return (
              <>
                <button
                  type="button"
                  role="radio"
                  class="k2b-choice-list__option"
                  aria-checked={checked()}
                  aria-describedby={option().description ? descriptionId : undefined}
                  disabled={props.disabled}
                  tabIndex={tabStop(option(), index) ? 0 : -1}
                  onClick={() => choose(index)}
                  onKeyDown={(event) => {
                    const target = radioKeyTarget(event.key, index, props.options.length);
                    if (target === undefined) return;
                    event.preventDefault();
                    choose(target, true);
                  }}
                >
                  <span class="k2b-choice-list__radio" aria-hidden="true" />
                  <span class="k2b-choice-list__text">
                    <span class="k2b-choice-list__label">
                      {option().label}
                      <Show when={option().marker}>{(marker) => <span class="k2b-choice-list__marker">{marker()}</span>}</Show>
                      {/* The spinner's place is always there, so a save starting or ending moves nothing. */}
                      <span class="k2b-choice-list__busy">
                        <Show when={checked() && props.busy}>
                          <i class="ti ti-loader-2 k2b-spin" role="img" aria-label={props.busyLabel} />
                        </Show>
                      </span>
                    </span>
                    <Show when={option().description}>
                      <span class="k2b-choice-list__description" id={descriptionId}>
                        {option().description}
                      </span>
                    </Show>
                  </span>
                </button>
                <Show when={checked() && props.details}>
                  <div class="k2b-choice-list__details">{props.details}</div>
                </Show>
              </>
            );
          }}
        </Index>
      </div>
    </Field>
  );
}
