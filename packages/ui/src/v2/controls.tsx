import {
  createContext,
  createRenderEffect,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  children as resolveChildren,
  Show,
  useContext,
} from "solid-js";
import { type ChoiceItem, useSelect } from "./behavior/select";
import { Icon } from "./marks";

type FieldIds = {
  /** The id of the one control the label names. */
  control: string;
  /** The id of the label line. */
  label: string;
  invalid: boolean;
  required: boolean;
  name?: string;
  /** The id of the hint or error, while there is one. */
  described?: string;
  /** A control of several choices (Check, Choice) makes the field a named group instead of a labelled control. */
  group: () => void;
  /**
   * A control whose id the behaviour layer owns (Select) is named by the label line through `aria-labelledby`, so the
   * label line points at no id with `for`; a press on the label line calls `focus`, as a label does for its control.
   */
  named: (focus: () => void) => void;
};
const FieldContext = createContext<FieldIds>();

export type FieldProps = {
  label: string;
  /** The name the value is sent under; the control inside takes it. */
  name?: string;
  /** A quiet hint under the control. */
  hint?: string;
  /** The error at the field; it replaces the hint and marks the control. */
  error?: string;
  /** "Optional" or a unit, quiet at the end of the label line. */
  optional?: string;
  /**
   * The form is not sent without a value here: the control says so to the browser and to assistive technology. The
   * label line shows nothing for it; the fields that may stay empty say "optional" instead (as the mockup does).
   */
  required?: boolean;
  children: JSX.Element;
};

/**
 * A field: a label line of 20 px, the control of 36 px, a hint or the error under it. The label line has a fixed
 * height, so fields in a row stand on one line (rule K5).
 */
export const Field = (props: FieldProps) => {
  const control = createUniqueId();
  const label = createUniqueId();
  const message = createUniqueId();
  // The control is made first, so the field knows whether it labels one control or names a group of choices; the
  // order is the same on the server and in the browser.
  let grouped = false;
  let named: (() => void) | undefined;
  const content = (
    <FieldContext.Provider
      value={{
        control,
        label,
        get invalid() {
          return !!props.error;
        },
        get required() {
          return props.required === true;
        },
        get name() {
          return props.name;
        },
        get described() {
          return props.error || props.hint ? message : undefined;
        },
        group: () => {
          grouped = true;
        },
        named: (focus) => {
          named = focus;
        },
      }}
    >
      {props.children}
    </FieldContext.Provider>
  );
  const labelLine = (
    <>
      {props.label}
      <Show when={props.optional}>
        <span class="k2-field-optional">{props.optional}</span>
      </Show>
    </>
  );
  const messageLine = (
    <Show when={props.error ?? props.hint}>
      {(text) => (
        <span class="k2-field-message" id={message} data-error={props.error ? "" : undefined} role={props.error ? "alert" : undefined}>
          {text()}
        </span>
      )}
    </Show>
  );
  // A group of choices is named by its label line; one control is labelled by it.
  return grouped ? (
    <div class="k2-field" data-k2-part="Field" role="group" aria-labelledby={label}>
      <span class="k2-field-label" id={label}>
        {labelLine}
      </span>
      {content}
      {messageLine}
    </div>
  ) : named ? (
    <div class="k2-field" data-k2-part="Field">
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: a pointer shortcut like a native label's; the control it names is the keyboard target. A <label for> would press the button and open its list. */}
      <span class="k2-field-label" id={label} onClick={() => named?.()}>
        {labelLine}
      </span>
      {content}
      {messageLine}
    </div>
  ) : (
    <div class="k2-field" data-k2-part="Field">
      <label class="k2-field-label" id={label} for={control}>
        {labelLine}
      </label>
      {content}
      {messageLine}
    </div>
  );
};

/** Fields side by side on one grid; one column on the phone. */
Field.Row = (props: { children: JSX.Element }) => (
  <div class="k2-frow" data-k2-part="Field.Row">
    {props.children}
  </div>
);

const useField = () => useContext(FieldContext);

export type InputProps = {
  value?: string;
  placeholder?: string;
  type?: "text" | "email" | "number" | "search" | "tel" | "url" | "password";
  /** A Tabler icon before the text, such as `search`. */
  icon?: string;
  /** A text of several lines (80 px). */
  multiline?: boolean;
  min?: number;
  max?: number;
  name?: string;
  /** A name when the input stands without a Field, such as a search in a head. */
  label?: string;
  onInput?: (value: string) => void;
  /**
   * A key in the field, such as Enter to search or Escape to clear; the handler may call `preventDefault`. While
   * `event.isComposing` is true the key belongs to an input method (Japanese, Chinese, …): Enter then confirms the
   * characters and must not search.
   */
  onKeyDown?: (event: KeyboardEvent) => void;
  /**
   * The text field itself, to focus it (`input.focus()`) or select its text: `let input; <Input ref={input} />` or a
   * function that takes it.
   */
  ref?: HTMLInputElement | HTMLTextAreaElement | ((element: HTMLInputElement | HTMLTextAreaElement) => void);
  /** At the end inside the field: a symbol, or a ghost icon button such as the filter of a search. */
  end?: JSX.Element;
  /** The value cannot be changed now: a grey well; the browser leaves it out of a form that is sent. */
  disabled?: boolean;
};

/** Hands the text field to a `ref` prop; Solid turns `ref={variable}` into a function that sets the variable. */
const forwardRef = (ref: InputProps["ref"], element: HTMLInputElement | HTMLTextAreaElement) => {
  if (typeof ref === "function") ref(element);
};

/** A round text field: 36 px, 1 px edge, a blue ring on focus. In a field it takes its name and error. */
export const Input = (props: InputProps) => {
  const field = useField();
  // the end is made once, here (reading the prop twice would make its JSX twice)
  const end = resolveChildren(() => props.end);
  const shared = () => ({
    id: field?.control,
    name: props.name ?? field?.name,
    placeholder: props.placeholder,
    value: props.value ?? "",
    "aria-label": field ? undefined : props.label,
    "aria-invalid": field?.invalid ? ("true" as const) : undefined,
    "aria-describedby": field?.described,
    required: field?.required || undefined,
    disabled: props.disabled,
  });
  return (
    <span
      class="k2-input"
      data-k2-part="Input"
      data-invalid={field?.invalid ? "" : undefined}
      data-disabled={props.disabled ? "" : undefined}
      data-multiline={props.multiline ? "" : undefined}
      data-search={props.type === "search" ? "" : undefined}
    >
      <Show when={props.icon}>{(name) => <Icon name={name()} />}</Show>
      <Show
        when={props.multiline}
        fallback={
          <input
            {...shared()}
            ref={(element) => forwardRef(props.ref, element)}
            type={props.type ?? "text"}
            min={props.min}
            max={props.max}
            onInput={(event) => props.onInput?.(event.currentTarget.value)}
            onKeyDown={(event) => props.onKeyDown?.(event)}
          />
        }
      >
        <textarea
          {...shared()}
          ref={(element) => forwardRef(props.ref, element)}
          onInput={(event) => props.onInput?.(event.currentTarget.value)}
          onKeyDown={(event) => props.onKeyDown?.(event)}
        />
      </Show>
      <Show when={end() !== undefined}>
        <span class="k2-input-end">{end()}</span>
      </Show>
    </span>
  );
};

export type SelectOption = { value: string; label: string; disabled?: boolean };

export type SelectProps = {
  options: readonly (string | SelectOption)[];
  /** The chosen value. With `onChange` the caller holds it; without, the selection keeps the choice itself. */
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  /** The name the value is sent under in a form; the field's name by default. */
  name?: string;
  /** A name for the selection when it stands without a Field. */
  label?: string;
};

/**
 * One value from a list: the round field shows it with a chevron, and the list opens below it with the keyboard,
 * typeahead and a check at the chosen option (the behaviour layer on the ui-sdk core). The list is at least as wide as
 * its field. The value reaches a form through core's form input: sent under the field's name, validated when the
 * field is required, put back by the form's reset, with a `change` event.
 */
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
        aria-labelledby={field?.label}
        aria-label={field ? undefined : props.label}
        aria-describedby={field?.described}
        aria-invalid={field?.invalid ? "true" : undefined}
      >
        <span class="k2-input-value" data-placeholder={value() === null ? "" : undefined}>
          <select.Value placeholder={props.placeholder ?? ""} />
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
            {item.label}
            <select.ItemIndicator item={item.value} class="k2-mi-meta">
              <Icon name="check" />
            </select.ItemIndicator>
          </select.Item>
        )}
      />
    </>
  );
};

export type DateInputProps = {
  value?: string;
  onInput?: (value: string) => void;
  placeholder?: string;
  name?: string;
  label?: string;
};

/** The shape of a date field: the date and a calendar symbol. (The picker opens with the behaviour layer.) */
export const DateInput = (props: DateInputProps) => {
  const field = useField();
  return (
    <span class="k2-input" data-k2-part="DateInput" data-invalid={field?.invalid ? "" : undefined}>
      <input
        id={field?.control}
        name={props.name ?? field?.name}
        type="text"
        inputmode="numeric"
        value={props.value ?? ""}
        placeholder={props.placeholder}
        aria-label={field ? undefined : props.label}
        aria-invalid={field?.invalid ? "true" : undefined}
        aria-describedby={field?.described}
        required={field?.required || undefined}
        onInput={(event) => props.onInput?.(event.currentTarget.value)}
      />
      <Icon name="calendar" />
    </span>
  );
};

export type CheckProps = {
  label: JSX.Element;
  name?: string;
  /** Set, not set, or mixed (some of a group). */
  checked?: boolean | "mixed";
  /** A switch instead of a box: on and off take effect at once. */
  switch?: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
};

/**
 * A box, or a switch, with its label. The mark takes exactly one 20 px text line and never aligns by baseline, so it
 * sits on the same pixel empty, set and mixed (guard: mark-geometry).
 */
export const Check = (props: CheckProps) => {
  const field = useField();
  field?.group();
  const [own, setOwn] = createSignal(props.checked);
  // With `onChange` the caller holds the state; without, the box keeps it, so the mark always shows what is set.
  const checked = () => (props.onChange ? props.checked : own());
  const set = () => checked() === true || checked() === "mixed";
  return (
    <label
      class="k2-choice"
      data-k2-part="Check"
      data-switch={props.switch ? "" : undefined}
      data-disabled={props.disabled ? "" : undefined}
    >
      <span class="k2-mark">
        <input
          class="k2-mark-input"
          type="checkbox"
          role={props.switch ? "switch" : undefined}
          name={props.name ?? field?.name}
          checked={checked() === true}
          ref={(input) => mixed(input, () => checked() === "mixed")}
          aria-describedby={field?.described}
          required={field?.required || undefined}
          disabled={props.disabled}
          onChange={(event) => {
            setOwn(event.currentTarget.checked);
            props.onChange?.(event.currentTarget.checked);
          }}
        />
        <Show
          when={props.switch}
          fallback={
            <span class="k2-check" data-checked={set() ? "" : undefined} data-k2-mark="">
              <Show when={set()}>
                <Icon name={checked() === "mixed" ? "minus" : "check"} />
              </Show>
            </span>
          }
        >
          <span class="k2-switch" data-checked={checked() === true ? "" : undefined} data-k2-mark="" />
        </Show>
      </span>
      <span class="k2-choice-text">{props.label}</span>
    </label>
  );
};

/**
 * A box that is set for some of a group shows it as the browser's own third state (`indeterminate`), which assistive
 * technology reads as "mixed"; it is a property of the box, not an attribute, so it follows in the browser.
 */
const mixed = (input: HTMLInputElement, when: () => boolean) => {
  createRenderEffect(() => {
    input.indeterminate = when();
  });
};

/** A box without visible words, named for assistive technology (internal: "select all", "select this row"). */
export const MarkCheck = (props: { label: string; checked?: boolean | "mixed"; onChange?: (checked: boolean) => void }) => (
  <span class="k2-mark">
    <input
      class="k2-mark-input"
      type="checkbox"
      aria-label={props.label}
      checked={props.checked === true}
      ref={(input) => mixed(input, () => props.checked === "mixed")}
      onChange={(event) => props.onChange?.(event.currentTarget.checked)}
    />
    <span class="k2-check" data-checked={props.checked ? "" : undefined} data-k2-mark="">
      <Show when={props.checked}>
        <Icon name={props.checked === "mixed" ? "minus" : "check"} />
      </Show>
    </span>
  </span>
);

export type ChoiceProps = {
  name: string;
  options: readonly (string | { value: string; label: string })[];
  value?: string;
  /** The question of the choice when it stands without a Field: shown as the label line of a field of its own. */
  label?: string;
  onChange?: (value: string) => void;
  /** The choice cannot be changed now: every option dimmed, the chosen one still shown. */
  disabled?: boolean;
};

/**
 * A few visible options, one of which is chosen: round points, each on one 20 px text line. With a `label` and no
 * Field around it, it stands in a field of its own, so its question is visible and names the group.
 */
export const Choice = (props: ChoiceProps) => {
  if (!useField() && props.label !== undefined)
    return (
      <Field label={props.label}>
        <ChoiceGroup {...props} />
      </Field>
    );
  return <ChoiceGroup {...props} />;
};

const ChoiceGroup = (props: ChoiceProps) => {
  const field = useField();
  field?.group();
  const options = () => props.options.map((option) => (typeof option === "string" ? { value: option, label: option } : option));
  const [own, setOwn] = createSignal(props.value);
  const value = () => (props.onChange ? props.value : own());
  return (
    <div
      class="k2-choices"
      data-k2-part="Choice"
      role="radiogroup"
      aria-label={field ? undefined : props.label}
      aria-labelledby={field?.label}
      aria-describedby={field?.described}
      aria-disabled={props.disabled ? "true" : undefined}
    >
      <For each={options()}>
        {(option) => (
          <label class="k2-choice" data-disabled={props.disabled ? "" : undefined}>
            <span class="k2-mark">
              <input
                class="k2-mark-input"
                type="radio"
                name={props.name}
                value={option.value}
                checked={option.value === value()}
                required={field?.required || undefined}
                disabled={props.disabled}
                onChange={() => {
                  setOwn(option.value);
                  props.onChange?.(option.value);
                }}
              />
              <span class="k2-radio" data-checked={option.value === value() ? "" : undefined} data-k2-mark="" />
            </span>
            <span class="k2-choice-text">{option.label}</span>
          </label>
        )}
      </For>
    </div>
  );
};
