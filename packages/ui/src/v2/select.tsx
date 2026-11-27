import { createSignal, Show } from "solid-js";
import { type ChoiceItem, useSelect } from "./behavior/select";
import { useField } from "./controls";
import { Icon } from "./marks";

export type SelectOption = {
  /** The value that is sent. */
  value: string;
  /** The words shown for it. */
  label: string;
  /** The option cannot be chosen now. */
  disabled?: boolean;
};

export type SelectProps = {
  /** The options: words, or a value with its words. */
  options: readonly (string | SelectOption)[];
  /** The chosen value. With `onChange` the caller holds it; without, the selection keeps the choice itself. */
  value?: string;
  /** Called with the value a person chose. */
  onChange?: (value: string) => void;
  /** The words while nothing is chosen, such as "Kunde wählen". */
  placeholder?: string;
  /** The name the value is sent under in a form; the field's name by default. */
  name?: string;
  /** A name for the selection when it stands without a Field. */
  label?: string;
  /**
   * The choice cannot be changed now (while saving, or a setting the person may not change): a grey well like a
   * disabled input, the chosen value still shown; it takes no focus and the browser leaves it out of a sent form. One
   * option that cannot be chosen takes `disabled` in its `SelectOption`.
   */
  disabled?: boolean;
};

/**
 * One value from a list: the round field shows it with a chevron, and the list opens below it with the keyboard,
 * typeahead and a check at the chosen option (the behaviour layer on the ui-sdk core). The list is at least as wide as
 * its field. The value reaches a form through core's form input: sent under the field's name, validated when the
 * field is required, put back by the form's reset, with a `change` event.
 */
/**
 * A value in one line that keeps what tells it apart: an address like `Anna Berg <anna@werkstatt.example>` shows its
 * start and its domain, and gives way in its middle (`Anna Be…@werkstatt.example>`); any other value gives way at its
 * end. The whole value is its hint, and its words stay whole for assistive technology.
 */
const Ends = (props: { text: string }) => {
  const at = () => props.text.lastIndexOf("@");
  return (
    <Show when={at() > 0} fallback={props.text}>
      {/* `dir="auto"`: an address keeps its own order (name, then domain) also in a right-to-left page */}
      <span class="k2-ends" title={props.text} dir="auto">
        {/* the two parts are boxes, which assistive technology would read with a space between: it reads the whole */}
        <span class="k2-ends-start" data-start="" aria-hidden="true">
          {props.text.slice(0, at())}
        </span>
        <span class="k2-ends-end" data-end="" aria-hidden="true">
          {props.text.slice(at())}
        </span>
        <span class="k2-hidden-text">{props.text}</span>
      </span>
    </Show>
  );
};

export const Select = (props: SelectProps) => {
  const field = useField();
  let trigger: HTMLElement | undefined;
  // the behaviour layer owns the trigger's id, so the field names it through aria-labelledby; its label focuses it
  field?.named(() => trigger?.focus());
  const items = (): ChoiceItem[] => props.options.map((option) => (typeof option === "string" ? { value: option, label: option } : option));
  // Without `onChange` core holds the choice (so a form's reset puts it back); the field only follows it.
  const [chosen, setChosen] = createSignal<string | null>(props.value ?? null);
  const value = () => (props.onChange ? (props.value ?? null) : chosen());
  const select = useSelect(() => ({
    items: items(),
    ...(props.onChange ? { value: props.value ?? null } : { defaultValue: props.value ?? null }),
    onValueChange: (next: string | null) => {
      // a form's reset may put back "nothing chosen"; the caller hears only of a value
      setChosen(next);
      if (next !== null) props.onChange?.(next);
    },
    placeholder: props.placeholder,
    disabled: props.disabled,
    required: field?.required,
    name: props.name ?? field?.name,
  }));
  return (
    <>
      <select.Trigger
        ref={(element: HTMLElement) => {
          trigger = element;
        }}
        class="k2-input"
        data-k2-part="Select"
        data-select=""
        data-invalid={field?.invalid ? "" : undefined}
        data-disabled={props.disabled ? "" : undefined}
        aria-labelledby={field?.label}
        aria-label={field ? undefined : props.label}
        aria-describedby={field?.described}
        aria-invalid={field?.invalid ? "true" : undefined}
      >
        <span class="k2-input-value" data-placeholder={value() === null ? "" : undefined}>
          {/* the value part of core, with the chosen label in a form that keeps its start and its domain */}
          <select.Value placeholder={props.placeholder ?? ""}>
            <Show when={items().find((item) => item.value === value())} fallback={props.placeholder ?? ""}>
              {(item) => <Ends text={item().label} />}
            </Show>
          </select.Value>
        </span>
        <Icon name="chevron-down" />
      </select.Trigger>
      {/* core's form input: sent, validated (`required`), reset with the form, and it fires `change` */}
      <select.FormInput />
      <select.Popup
        class="k2-menu"
        data-listbox=""
        sideOffset={4}
        collisionPadding={8}
        option={(item: ChoiceItem) => (
          <select.Item class="k2-mi" value={item.value} label={item.label} disabled={item.disabled}>
            <span class="k2-mi-label">
              <Ends text={item.label} />
            </span>
            <select.ItemIndicator item={item.value} class="k2-mi-meta">
              <Icon name="check" />
            </select.ItemIndicator>
          </select.Item>
        )}
      />
    </>
  );
};
