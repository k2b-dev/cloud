import { createContext, createUniqueId, For, type JSX, Show, useContext } from "solid-js";
import { Icon } from "./marks";

type FieldIds = { control: string; message: string; invalid: boolean; name?: string };
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
  children: JSX.Element;
};

/**
 * A field: a label line of 20 px, the control of 36 px, a hint or the error under it. The label line has a fixed
 * height, so fields in a row stand on one line (rule K5).
 */
export const Field = (props: FieldProps) => {
  const control = createUniqueId();
  const message = createUniqueId();
  return (
    <div class="k2-field" data-k2-part="Field">
      <label class="k2-field-label" for={control}>
        {props.label}
        <Show when={props.optional}>
          <span class="k2-field-optional">{props.optional}</span>
        </Show>
      </label>
      <FieldContext.Provider
        value={{
          control,
          message,
          get invalid() {
            return !!props.error;
          },
          get name() {
            return props.name;
          },
        }}
      >
        {props.children}
      </FieldContext.Provider>
      <Show when={props.error ?? props.hint}>
        {(text) => (
          <span class="k2-field-message" id={message} data-error={props.error ? "" : undefined} role={props.error ? "alert" : undefined}>
            {text()}
          </span>
        )}
      </Show>
    </div>
  );
};

/** Fields side by side on one grid; one column on the phone. */
Field.Row = (props: { children: JSX.Element }) => {
  const count = () => {
    const children = props.children;
    return Array.isArray(children) ? children.length : 1;
  };
  return (
    <div class="k2-frow" data-k2-part="Field.Row" style={{ "--k2-fields": String(count()) }}>
      {props.children}
    </div>
  );
};

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
};

/** A round text field: 36 px, 1 px edge, a blue ring on focus. In a field it takes its name and error. */
export const Input = (props: InputProps) => {
  const field = useField();
  const shared = () => ({
    id: field?.control,
    name: props.name ?? field?.name,
    placeholder: props.placeholder,
    value: props.value ?? "",
    "aria-label": field ? undefined : props.label,
    "aria-invalid": field?.invalid ? ("true" as const) : undefined,
    "aria-describedby": field ? field.message : undefined,
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
            type={props.type ?? "text"}
            min={props.min}
            max={props.max}
            onInput={(event) => props.onInput?.(event.currentTarget.value)}
          />
        }
      >
        <textarea {...shared()} onInput={(event) => props.onInput?.(event.currentTarget.value)} />
      </Show>
    </span>
  );
};

export type SelectProps = {
  options: readonly (string | { value: string; label: string })[];
  value?: string;
  placeholder?: string;
  name?: string;
  label?: string;
};

/**
 * The closed shape of a selection: the value and a chevron in the round field. (The list opens with the behaviour
 * layer; until then it is a native select laid over the shape, so it works with the keyboard and in forms.)
 */
export const Select = (props: SelectProps) => {
  const field = useField();
  const options = () => props.options.map((option) => (typeof option === "string" ? { value: option, label: option } : option));
  const current = () => options().find((option) => option.value === props.value);
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
      >
        <Show when={!current()}>
          <option value="">{props.placeholder ?? ""}</option>
        </Show>
        <For each={options()}>
          {(option) => (
            <option value={option.value} selected={option.value === props.value}>
              {option.label}
            </option>
          )}
        </For>
      </select>
    </span>
  );
};

export type DateInputProps = { value?: string; placeholder?: string; name?: string; label?: string };

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
  const set = () => props.checked === true || props.checked === "mixed";
  return (
    <label class="k2-choice" data-k2-part="Check" data-switch={props.switch ? "" : undefined}>
      <span class="k2-mark">
        <input
          class="k2-mark-input"
          type="checkbox"
          role={props.switch ? "switch" : undefined}
          name={props.name}
          checked={props.checked === true}
          aria-checked={props.checked === "mixed" ? "mixed" : undefined}
          disabled={props.disabled}
          onChange={(event) => props.onChange?.(event.currentTarget.checked)}
        />
        <Show
          when={props.switch}
          fallback={
            <span class="k2-check" data-checked={set() ? "" : undefined} data-k2-mark="">
              <Show when={set()}>
                <Icon name={props.checked === "mixed" ? "minus" : "check"} />
              </Show>
            </span>
          }
        >
          <span class="k2-switch" data-checked={props.checked === true ? "" : undefined} data-k2-mark="" />
        </Show>
      </span>
      <span class="k2-choice-text">{props.label}</span>
    </label>
  );
};

export type ChoiceProps = {
  name: string;
  options: readonly (string | { value: string; label: string })[];
  value?: string;
  /** A name for the group when it stands without a Field. */
  label?: string;
  onChange?: (value: string) => void;
};

/** A few visible options, one of which is chosen: round points, each on one 20 px text line. */
export const Choice = (props: ChoiceProps) => {
  const options = () => props.options.map((option) => (typeof option === "string" ? { value: option, label: option } : option));
  return (
    <div class="k2-choices" data-k2-part="Choice" role="radiogroup" aria-label={props.label}>
      <For each={options()}>
        {(option) => (
          <label class="k2-choice">
            <span class="k2-mark">
              <input
                class="k2-mark-input"
                type="radio"
                name={props.name}
                value={option.value}
                checked={option.value === props.value}
                onChange={() => props.onChange?.(option.value)}
              />
              <span class="k2-radio" data-checked={option.value === props.value ? "" : undefined} data-k2-mark="" />
            </span>
            <span class="k2-choice-text">{option.label}</span>
          </label>
        )}
      </For>
    </div>
  );
};
