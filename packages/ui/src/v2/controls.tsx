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
  });
  return (
    <span
      class="k2-input"
      data-k2-part="Input"
      data-invalid={field?.invalid ? "" : undefined}
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

export type SelectProps = {
  options: readonly (string | { value: string; label: string })[];
  /** The chosen value. With `onChange` the caller holds it; without, the selection keeps the choice itself. */
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  name?: string;
  label?: string;
};

/**
 * The closed shape of a selection: the value and a chevron in the round field. (The list opens with the behaviour
 * layer; until then it is a native select laid over the shape, so it works with the keyboard and in forms.) The
 * shape always shows the value that is chosen now.
 */
export const Select = (props: SelectProps) => {
  const field = useField();
  const options = () => props.options.map((option) => (typeof option === "string" ? { value: option, label: option } : option));
  const [chosen, setChosen] = createSignal(props.value);
  const value = () => (props.onChange ? props.value : chosen());
  const current = () => options().find((option) => option.value === value());
  return (
    <span class="k2-input" data-k2-part="Select" data-select="" data-invalid={field?.invalid ? "" : undefined}>
      <span class="k2-input-value" data-placeholder={current() ? undefined : ""}>
        {current()?.label ?? props.placeholder ?? ""}
      </span>
      <Icon name="chevron-down" />
      <select
        class="k2-native-select"
        id={field?.control}
        name={props.name ?? field?.name}
        aria-label={field ? undefined : props.label}
        aria-invalid={field?.invalid ? "true" : undefined}
        aria-describedby={field?.described}
        required={field?.required || undefined}
        onChange={(event) => {
          setChosen(event.currentTarget.value);
          props.onChange?.(event.currentTarget.value);
        }}
      >
        <Show when={!current()}>
          <option value="">{props.placeholder ?? ""}</option>
        </Show>
        <For each={options()}>
          {(option) => (
            <option value={option.value} selected={option.value === value()}>
              {option.label}
            </option>
          )}
        </For>
      </select>
    </span>
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
    <label class="k2-choice" data-k2-part="Check" data-switch={props.switch ? "" : undefined}>
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

/**
 * A box without visible words, named for assistive technology by a `label` or by the element `labelledBy` (internal:
 * "select all", "select this row", a row's box named by its title).
 */
export const MarkCheck = (
  props: ({ label: string; labelledBy?: undefined } | { label?: undefined; labelledBy: string }) & {
    checked?: boolean | "mixed";
    onChange?: (checked: boolean) => void;
  },
) => (
  <span class="k2-mark">
    <input
      class="k2-mark-input"
      type="checkbox"
      aria-label={props.label}
      aria-labelledby={props.labelledBy}
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
    >
      <For each={options()}>
        {(option) => (
          <label class="k2-choice">
            <span class="k2-mark">
              <input
                class="k2-mark-input"
                type="radio"
                name={props.name}
                value={option.value}
                checked={option.value === value()}
                required={field?.required || undefined}
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
