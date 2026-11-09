import { type JSX, Show } from "solid-js";
import { CopyButton } from "../actions/CopyButton";
import { useSectionMessages } from "./section-messages";

/** Props of `Field`, a shown value; input fields share `FieldProps`. */
export type FieldRowProps = {
  label: string;
  /** The value; pass `children` instead for rich content. */
  value?: JSX.Element;
  children?: JSX.Element;
  /** `true` copies a text `value`; a string copies that string, such as the full form of a shortened value. */
  copy?: boolean | string;
  /** `email` links a text value and breaks it only after the `@`. */
  kind?: "text" | "email";
  /** `row` puts the value beside its label and moves it below when it does not fit; `stack` always below. */
  layout?: "row" | "stack";
  class?: string;
};

/** Splits an address after its `@`, so it only breaks there. */
const emailParts = (address: string): JSX.Element => {
  const at = address.indexOf("@");
  if (at < 0) return address;
  return (
    <>
      <span class="k2b-field-row__nowrap">{address.slice(0, at + 1)}</span>
      <wbr />
      <span class="k2b-field-row__nowrap">{address.slice(at + 1)}</span>
    </>
  );
};

/**
 * A label on the left and its value on the right, with an optional copy button that always keeps its place. Its own
 * module, so a section without fields carries neither the copy button nor its label.
 */
export function Field(props: FieldRowProps): JSX.Element {
  const messages = useSectionMessages();
  const text = () => (typeof props.value === "string" ? props.value : undefined);
  const copyValue = () => (typeof props.copy === "string" ? props.copy : props.copy ? text() : undefined);
  const content = () => {
    const value = text();
    if (props.kind === "email" && value) return <a href={`mailto:${value}`}>{emailParts(value)}</a>;
    return props.value ?? props.children;
  };
  return (
    <div class={props.class ? `k2b-field-row ${props.class}` : "k2b-field-row"} data-layout={props.layout ?? "row"} data-kind={props.kind}>
      <span class="k2b-field-row__label">{props.label}</span>
      <span class="k2b-field-row__value">
        <span
          class="k2b-field-row__text"
          title={props.layout !== "stack" ? (typeof props.copy === "string" ? props.copy : text()) : undefined}
        >
          {content()}
        </span>
        {/* Without a copy button the slot stays, so every value of a section ends on one edge. */}
        <Show when={copyValue()} fallback={<span class="k2b-field-row__slot" aria-hidden="true" />}>
          {(value) => (
            <CopyButton
              class="k2b-field-row__copy"
              value={value()}
              size="xs"
              iconOnly
              label={messages().copyField({ label: props.label })}
            />
          )}
        </Show>
      </span>
    </div>
  );
}
