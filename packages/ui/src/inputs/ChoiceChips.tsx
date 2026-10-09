import type { JSX } from "solid-js";
import { createFieldMeta, Field, fieldDescribedBy } from "../internal/field";
import { ChoiceGroups } from "./ChoiceGroups";
import type { ValueFieldProps } from "./field-contract";
import { resolveMaybeAccessor } from "./field-contract";

export type ChoiceChipOption<T extends string = string> = {
  value: T;
  label: string;
  icon?: string;
};

export type ChoiceChipsProps<T extends string = string> = Omit<ValueFieldProps<T | null>, "onValueChange" | "onValueCommit"> & {
  options: readonly ChoiceChipOption<T>[];
  /** Receives the chosen value; choosing never reports `null`. */
  onValueChange?: (value: T) => void;
  onValueCommit?: (value: T) => void;
};

/**
 * A labeled single choice shown as one row of chips, for a handful of quick picks such as a preset or a proposed date.
 * The row scrolls sideways instead of wrapping, so its height stays the same on every screen and for every selection.
 * `null` selects no chip; the first chip then holds the tab stop. Use `Select` for long or searchable lists and
 * `SegmentedControl` for switching between views or modes.
 */
export function ChoiceChips<T extends string = string>(props: ChoiceChipsProps<T>): JSX.Element {
  const meta = createFieldMeta(props.id);
  const value = () => resolveMaybeAccessor(props.value) ?? null;
  return (
    <Field
      meta={meta}
      labelFor={false}
      class={`k2b-choice-chips ${props.class ?? ""}`}
      label={props.label}
      description={props.description}
      error={props.error}
      required={props.required}
      disabled={props.disabled}
    >
      <ChoiceGroups
        choices={props.options}
        value={value()}
        onValueChange={(next) => {
          const option = props.options.find((candidate) => candidate.value === next);
          if (!option) return;
          props.onValueChange?.(option.value);
          props.onValueCommit?.(option.value);
        }}
        ariaLabel={props["aria-label"]}
        labelledBy={props.label ? meta.labelId : undefined}
        describedBy={fieldDescribedBy(meta, props)}
        disabled={props.disabled}
      />
    </Field>
  );
}
