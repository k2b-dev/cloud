import { createUniqueId, type JSX, Show } from "solid-js";
import type { FieldProps } from "../inputs/field-contract";
import { resolveMaybeAccessor } from "../inputs/field-contract";

export type FieldMeta = {
  controlId: string;
  labelId: string;
  descriptionId: string;
  errorId: string;
};

export const createFieldMeta = (id?: string): FieldMeta => {
  const generatedId = createUniqueId();
  const controlId = id ?? `k2b-field-${generatedId}`;

  return {
    controlId,
    labelId: `${controlId}-label`,
    descriptionId: `${controlId}-description`,
    errorId: `${controlId}-error`,
  };
};

type FieldLayoutProps = {
  children: JSX.Element;
  meta: FieldMeta;
  fill?: boolean;
  /** Composite controls use aria-labelledby instead of an HTML label target. */
  labelFor?: string | false;
  /** Optional controls beside the label, outside its clickable target. */
  labelEnd?: JSX.Element;
} & Pick<FieldProps, "class" | "description" | "error" | "label" | "required" | "disabled">;

export function Field(props: FieldLayoutProps): JSX.Element {
  const error = () => resolveMaybeAccessor(props.error);
  const label = () => (
    <Show
      when={props.labelFor !== false}
      fallback={
        <span id={props.meta.labelId} class="k2b-field__label">
          {props.label}
          <Show when={props.required}>
            <span class="k2b-field__required" aria-hidden="true">
              *
            </span>
          </Show>
        </span>
      }
    >
      <label id={props.meta.labelId} class="k2b-field__label" for={props.labelFor || props.meta.controlId}>
        {props.label}
        <Show when={props.required}>
          <span class="k2b-field__required" aria-hidden="true">
            *
          </span>
        </Show>
      </label>
    </Show>
  );

  return (
    <div
      class={`k2b-field ${props.class ?? ""}`}
      data-disabled={props.disabled ? "true" : undefined}
      data-fill={props.fill ? "true" : undefined}
      data-invalid={error() ? "true" : undefined}
    >
      <Show when={props.label}>
        <Show when={props.labelEnd} fallback={label()}>
          <div class="k2b-field__label k2b-field__label-row">
            {label()}
            {props.labelEnd}
          </div>
        </Show>
      </Show>
      <Show when={props.description}>
        <p class="k2b-field__description" id={props.meta.descriptionId}>
          {props.description}
        </p>
      </Show>
      {props.children}
      <Show when={error()}>
        <p class="k2b-field__error" id={props.meta.errorId} role="alert" aria-live="polite">
          {error()}
        </p>
      </Show>
    </div>
  );
}

type FieldAriaOwner = Pick<FieldProps, "aria-describedby" | "aria-label" | "description" | "error" | "label" | "required">;

export const fieldDescribedBy = (meta: FieldMeta, owner: FieldAriaOwner): string | undefined =>
  [
    owner["aria-describedby"],
    owner.description ? meta.descriptionId : undefined,
    resolveMaybeAccessor(owner.error) ? meta.errorId : undefined,
  ]
    .filter(Boolean)
    .join(" ") || undefined;

export const fieldControlAria = (meta: FieldMeta, owner: FieldAriaOwner) => ({
  get "aria-label"() {
    return owner.label ? undefined : owner["aria-label"];
  },
  get "aria-labelledby"() {
    return owner.label ? meta.labelId : undefined;
  },
  get "aria-describedby"() {
    return fieldDescribedBy(meta, owner);
  },
  get "aria-invalid"() {
    return resolveMaybeAccessor(owner.error) ? ("true" as const) : undefined;
  },
  get "aria-required"() {
    return owner.required || undefined;
  },
});
