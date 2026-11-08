import { type JSX, Show, splitProps } from "solid-js";
import { createFieldMeta, fieldControlAria } from "../internal/field";
import type { FieldSuggestionProps, ValueFieldProps } from "./field-contract";
import { commitFieldValue, resolveMaybeAccessor } from "./field-contract";
import { useFieldSuggestion } from "./field-suggestion-slot";

export type SwitchProps = ValueFieldProps<boolean> &
  /**
   * A switch always has a value, so it shows a suggestion until someone flips it: the switch keeps its real
   * position, takes the suggestion ring, and names the suggested position beside it. The label then moves above
   * the switch, next to the status line.
   */
  FieldSuggestionProps<boolean> & {
    name?: string;
  };

export function Switch(props: SwitchProps): JSX.Element {
  const [local, rest] = splitProps(props, ["label", "onValueChange", "onValueCommit", "value"]);
  const meta = createFieldMeta(props.id);
  const checked = () => resolveMaybeAccessor(local.value) ?? false;
  const error = () => resolveMaybeAccessor(props.error);
  const suggestion = useFieldSuggestion({
    props,
    enabled: "suggestion" in props,
    meta,
    value: checked,
    // Off is a position, not an empty value: the switch is open for a suggestion until someone flips it.
    blank: () => true,
    locked: () => Boolean(rest.disabled),
    invalid: () => Boolean(error()),
    apply: (on) => commitFieldValue(local, on),
    spokenValue: true,
  });
  const required = () => (
    <Show when={rest.required}>
      <span class="k2b-field__required" aria-hidden="true">
        *
      </span>
    </Show>
  );
  const control = (label?: JSX.Element) => (
    <label class="k2b-switch" data-suggestion={suggestion.state()}>
      <input
        id={meta.controlId}
        name={props.name}
        type="checkbox"
        role="switch"
        checked={checked()}
        disabled={rest.disabled}
        required={rest.required}
        {...fieldControlAria(meta, props, suggestion)}
        onChange={(event) => {
          suggestion.edited();
          commitFieldValue(local, event.currentTarget.checked);
        }}
      />
      <span class="k2b-switch__track" aria-hidden="true">
        <span class="k2b-switch__thumb" />
      </span>
      {label}
    </label>
  );

  return (
    <div
      class={`k2b-switch-field ${suggestion.enabled ? "k2b-ai-suggestion-field " : ""}${props.class ?? ""}`}
      data-disabled={rest.disabled ? "true" : undefined}
      data-invalid={error() ? "true" : undefined}
    >
      <Show
        when={suggestion.enabled}
        fallback={control(
          local.label && (
            <span id={meta.labelId} class="k2b-switch__label">
              {local.label}
              {required()}
            </span>
          ),
        )}
      >
        <Show when={local.label}>
          <div class="k2b-field__label-row">
            <label id={meta.labelId} class="k2b-field__label" for={meta.controlId}>
              {local.label}
              {required()}
            </label>
            {suggestion.status?.()}
          </div>
        </Show>
        {/* Without a visible label the status line sits under the switch, in a reserved line like other fields. */}
        <div class={local.label ? undefined : "k2b-ai-suggestion-field__control"}>
          <div class="k2b-ai-suggestion-switch">
            {control()}
            {/* The suggested position, in the line the switch label used; its size never changes. */}
            <span class="k2b-ai-suggestion-switch__value" aria-hidden="true">
              {suggestion.inline() ?? ""}
            </span>
          </div>
          <Show when={!local.label}>{suggestion.status?.()}</Show>
        </div>
      </Show>
      <Show when={props.description}>
        <span id={meta.descriptionId} class="k2b-field__description">
          {props.description}
        </span>
      </Show>
      <Show when={error()}>
        <p id={meta.errorId} class="k2b-field__error" role="alert" aria-live="polite">
          {error()}
        </p>
      </Show>
    </div>
  );
}

export default Switch;
