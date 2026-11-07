import { For, type JSX } from "solid-js";
import { createFieldMeta, Field, fieldDescribedBy } from "../internal/field";
import { radioKeyTarget } from "../internal/radio-keys";
import type { ValueFieldProps } from "./field-contract";
import { resolveMaybeAccessor } from "./field-contract";

export type ChoiceTileOption<T extends string = string> = {
  value: T;
  label: string;
  /** What the choice looks like, such as a preview image; decorative, the label names the choice. */
  visual: JSX.Element;
  /** A short state under the label, such as "Active"; keeps its line, so tiles never change height. */
  status?: string;
};

export type ChoiceTilesProps<T extends string = string> = Omit<ValueFieldProps<T | null>, "onValueChange" | "onValueCommit"> & {
  options: readonly ChoiceTileOption<T>[];
  /** `grid`: preview over label in as many columns as fit. `row`: preview beside label in one row, stacked on phones. */
  layout?: "grid" | "row";
  /** The choice is kept but has no visible effect right now; previews are dimmed, choosing still works. */
  dimmed?: boolean;
  onValueChange?: (value: T) => void;
  onValueCommit?: (value: T) => void;
};

/**
 * A labeled single choice shown as tiles with a preview, for picking how something looks: a face shape, a frame, a
 * kind of picture. Every tile keeps its size when chosen, so nothing moves. Use `ChoiceChips` for text choices and
 * `ColorChoices` for named colours.
 */
export function ChoiceTiles<T extends string = string>(props: ChoiceTilesProps<T>): JSX.Element {
  const meta = createFieldMeta(props.id);
  let group: HTMLDivElement | undefined;
  const value = () => resolveMaybeAccessor(props.value) ?? null;
  const tabStop = (option: ChoiceTileOption<T>, index: number) =>
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
        class="k2b-choice-tiles__group"
        ref={group}
        role="radiogroup"
        data-layout={props.layout ?? "grid"}
        data-dimmed={props.dimmed ? "true" : undefined}
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
              class="k2b-choice-tiles__tile"
              aria-checked={value() === option.value}
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
              <span class="k2b-choice-tiles__visual" aria-hidden="true">
                {option.visual}
              </span>
              <span class="k2b-choice-tiles__text">
                <span class="k2b-choice-tiles__label">{option.label}</span>
                {props.layout === "row" && <span class="k2b-choice-tiles__status">{option.status ?? ""}</span>}
              </span>
            </button>
          )}
        </For>
      </div>
    </Field>
  );
}
