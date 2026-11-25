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
import { isServer } from "solid-js/web";
import { useLocale } from "../intl/locale";
import { useCode } from "./behavior/code";
import { useFilePick } from "./behavior/files";
import { useColor, useRange } from "./behavior/pickers";
import { type ChoiceItem, useCombobox, useSelect } from "./behavior/select";
import { ActionButton, Button } from "./button";
import { useControlMessages } from "./control-messages";
import { Icon } from "./marks";
import { textEdge } from "./tokens";
import type { Action } from "./types";

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
  /** The question of the field, above the control. */
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
  /**
   * One quiet deed for this field at the end of its label line, such as "Auf Standard zurücksetzen": a text button of
   * the label line's 20 px, so the field keeps its height with and without it. It takes the place of `optional`.
   */
  action?: Action;
  /** The one control: `Input`, `Select`, `DateInput`, `Choice`, `TagsInput`, `ImageInput`, `CodeInput`, `Slider` or `ColorInput`. */
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
      <Show when={props.optional && !props.action}>
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
  // The deed stands beside the label line, never in it: a button inside a <label> would be pressed with it.
  const actionLine = (
    <Show when={props.action}>
      {(action) => (
        <span class="k2-field-action">
          <ActionButton action={action()} variant="text" />
        </span>
      )}
    </Show>
  );
  // A group of choices is named by its label line; one control is labelled by it.
  return grouped ? (
    <div class="k2-field" data-k2-part="Field" data-action={props.action ? "" : undefined} role="group" aria-labelledby={label}>
      <span class="k2-field-label" id={label}>
        {labelLine}
      </span>
      {actionLine}
      {content}
      {messageLine}
    </div>
  ) : named ? (
    <div class="k2-field" data-k2-part="Field" data-action={props.action ? "" : undefined}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: a pointer shortcut like a native label's; the control it names is the keyboard target. A <label for> would press the button and open its list. */}
      <span class="k2-field-label" id={label} onClick={() => named?.()}>
        {labelLine}
      </span>
      {actionLine}
      {content}
      {messageLine}
    </div>
  ) : (
    <div class="k2-field" data-k2-part="Field" data-action={props.action ? "" : undefined}>
      <label class="k2-field-label" id={label} for={control}>
        {labelLine}
      </label>
      {actionLine}
      {content}
      {messageLine}
    </div>
  );
};

/** Fields side by side on one grid; one column on the phone. */
Field.Row = (props: {
  /** The `Field`s side by side. */
  children: JSX.Element;
}) => (
  <div class="k2-frow" data-k2-part="Field.Row">
    {props.children}
  </div>
);

const useField = () => useContext(FieldContext);

export type InputProps = {
  /** The text in the field. */
  value?: string;
  /** A quiet example while the field is empty. */
  placeholder?: string;
  /**
   * The kind of text, which picks the phone's keyboard; `text` when not set. A `search` in the head of a workspace
   * or pane stays on the phone as its symbol (36 px, like an icon button), where the other head actions hide: a tap
   * goes into the field, which opens over the head while it has the focus and folds back, its words kept, when the
   * focus leaves or on Escape (unless `onKeyDown` takes Escape itself with `preventDefault`).
   */
  type?: "text" | "email" | "number" | "search" | "tel" | "url" | "password";
  /** A Tabler icon before the text, such as `search`. */
  icon?: string;
  /** A text of several lines (80 px). */
  multiline?: boolean;
  /** The smallest number a `number` field takes. */
  min?: number;
  /** The largest number a `number` field takes. */
  max?: number;
  /** The name the value is sent under in a form; the field's name by default. */
  name?: string;
  /** A name when the input stands without a Field, such as a search in a head. */
  label?: string;
  /** Called with the new text on every change. */
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

/**
 * Escape in the search of a head on the phone, where the field opens over the head only while it has the focus: it
 * folds the field back and keeps its words (the browser would clear them and leave the field open). A caller that
 * takes Escape itself (`onKeyDown` calls `preventDefault`) decides alone.
 */
const foldHeadSearch = (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
  const place = event.currentTarget.parentElement?.parentElement;
  if (!place?.matches('[data-slot="head"] > .k2-bar > .k2-bar-end')) return;
  if (!matchMedia(`not all and (min-width: ${textEdge.phoneBelow}px)`).matches) return;
  event.preventDefault();
  event.currentTarget.blur();
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
            onKeyDown={(event) => {
              props.onKeyDown?.(event);
              if (props.type === "search") foldHeadSearch(event);
            }}
          />
        }
      >
        {/* A textarea's value is its text: the server sends it there, so the first render already shows it; in the browser
            the value property holds it. HTML drops one newline at the start of a textarea's text, so the server sends
            one before the value: a value that starts with a blank line keeps it. */}
        <textarea
          {...shared()}
          ref={(element) => forwardRef(props.ref, element)}
          onInput={(event) => props.onInput?.(event.currentTarget.value)}
          onKeyDown={(event) => props.onKeyDown?.(event)}
        >
          {isServer ? `\n${props.value ?? ""}` : undefined}
        </textarea>
      </Show>
      <Show when={end() !== undefined}>
        <span class="k2-input-end">{end()}</span>
      </Show>
    </span>
  );
};

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

export type CodeInputProps = {
  /** The code. With `onInput` the caller holds it; without, the field keeps it. */
  value?: string;
  onInput?: (value: string) => void;
  /** The last box is filled: the whole code, such as to check it at once. */
  onComplete?: (value: string) => void;
  /** How many characters the code has, one box each (6 by default). */
  length?: number;
  /** Which characters it takes: `digits` (the default, with the number keyboard on a phone) or `alphanumeric`. */
  characters?: "digits" | "alphanumeric";
  /** The name the value is sent under in a form; the field's name by default. */
  name?: string;
  /** A name when the code stands without a Field. */
  label?: string;
  disabled?: boolean;
  /**
   * What the browser may fill in: `one-time-code` (the default) lets a phone offer the code from a message and a
   * password manager fill it; `off` for a code shown on another device, such as a pairing code.
   */
  autocomplete?: "one-time-code" | "off";
};

/**
 * A one-time or pairing code: a box per character (36 px, round like an input), one real input under them that takes
 * typing, pasting and autofill, and is what assistive technology hears and a form sends (the behaviour layer on the
 * ui-sdk core).
 */
export const CodeInput = (props: CodeInputProps) => {
  const field = useField();
  const length = () => props.length ?? 6;
  const code = useCode(() => ({
    ...(props.onInput ? { value: props.value ?? "" } : { defaultValue: props.value ?? "" }),
    onValueChange: (next: string) => props.onInput?.(next),
    onValueCommit: (next: string) => props.onComplete?.(next),
    maxLength: length(),
    pattern: props.characters ?? "digits",
    autoComplete: props.autocomplete ?? "one-time-code",
    disabled: props.disabled,
    required: field?.required,
    name: props.name ?? field?.name,
  }));
  return (
    <code.Root
      class="k2-code"
      data-k2-part="CodeInput"
      data-invalid={field?.invalid ? "" : undefined}
      data-disabled={props.disabled ? "" : undefined}
    >
      <code.Control
        id={field?.control}
        aria-label={field ? undefined : props.label}
        aria-invalid={field?.invalid ? "true" : undefined}
        aria-describedby={field?.described}
      />
      <code.Group class="k2-code-boxes">
        <For each={Array.from({ length: length() }, (_, index) => index)}>
          {(index) => (
            <code.Slot index={index} class="k2-code-box">
              {(state: { char?: string | null; hasFakeCaret?: boolean }) => (
                <>
                  {state.char ?? ""}
                  <Show when={state.hasFakeCaret}>
                    <span class="k2-code-caret" />
                  </Show>
                </>
              )}
            </code.Slot>
          )}
        </For>
      </code.Group>
    </code.Root>
  );
};

export type TagsInputProps = {
  /** The values, in their order. With `onChange` the caller holds them; without, the field keeps them. */
  value?: readonly string[];
  onChange?: (values: string[]) => void;
  /** Values to pick from while typing; any other text becomes a value too, on Enter. */
  suggestions?: readonly string[];
  placeholder?: string;
  /** The name the values are sent under, one entry each; the field's name by default. */
  name?: string;
  /** A name when the field stands without a Field. */
  label?: string;
  disabled?: boolean;
};

/**
 * Several short values, such as domains or server addresses: each a chip with its remove button, typed into the field
 * after them; Enter adds the text, Backspace in an empty field takes the last chip back (the behaviour layer on the
 * ui-sdk core). The field grows by a line when the chips need one.
 */
export const TagsInput = (props: TagsInputProps) => {
  const field = useField();
  const t = useControlMessages();
  const [own, setOwn] = createSignal<string[]>([...(props.value ?? [])]);
  const values = () => (props.onChange ? [...(props.value ?? [])] : own());
  const items = (): ChoiceItem[] => [...new Set([...(props.suggestions ?? []), ...values()])].map((value) => ({ value, label: value }));
  const combo = useCombobox(() => ({
    items: items(),
    multiple: true as const,
    allowCustomValue: true,
    value: values(),
    onValueChange: (next: string[]) => {
      const clean = [...new Set(next.map((value) => value.trim()).filter(Boolean))];
      setOwn(clean);
      props.onChange?.(clean);
    },
    disabled: props.disabled,
    required: field?.required,
    name: props.name ?? field?.name,
  }));
  return (
    <>
      <combo.Chips
        class="k2-input"
        data-k2-part="TagsInput"
        data-tags=""
        data-invalid={field?.invalid ? "" : undefined}
        data-disabled={props.disabled ? "" : undefined}
      >
        <For each={values()}>
          {(value) => (
            <combo.Chip class="k2-chip" value={value}>
              {value}
              <combo.ChipRemove class="k2-chip-x" value={value} aria-label={t().removeValue({ label: value })}>
                <Icon name="x" />
              </combo.ChipRemove>
            </combo.Chip>
          )}
        </For>
        <combo.Input
          id={field?.control}
          placeholder={values().length ? undefined : props.placeholder}
          aria-label={field ? undefined : props.label}
          aria-invalid={field?.invalid ? "true" : undefined}
          aria-describedby={field?.described}
        />
      </combo.Chips>
      <combo.FormInput />
      <Show when={props.suggestions?.length}>
        <combo.Popup
          class="k2-menu"
          data-listbox=""
          sideOffset={4}
          collisionPadding={8}
          option={(item: ChoiceItem) => (
            <combo.Item class="k2-mi" value={item.value} label={item.label}>
              {item.label}
              <combo.ItemIndicator item={item.value} class="k2-mi-meta">
                <Icon name="check" />
              </combo.ItemIndicator>
            </combo.Item>
          )}
        />
      </Show>
    </>
  );
};

export type ImageInputProps = {
  /** The address of the image (a URL or a data URL); `null` or empty for none. */
  value?: string | null;
  /** The new image, made from the picked file by `transform`, or `null` when it was removed. */
  onChange: (value: string | null) => void;
  /**
   * Turns the picked file into the value. By default a square picture of 512 px as a data URL (as for an avatar or a
   * logo); pass your own to upload the file and return its address.
   */
  transform?: (file: File) => Promise<string>;
  /** The file types to take, like the `accept` attribute; images by default. */
  accept?: string;
  /** A round preview, for a person's picture. */
  round?: boolean;
  /** The name the value is sent under in a form; the field's name by default. */
  name?: string;
  /** A name when the picker stands without a Field. */
  label?: string;
  disabled?: boolean;
};

const imageAccept = "image/jpeg,image/png,image/gif,image/webp,image/svg+xml,.jpg,.jpeg,.png,.gif,.webp,.svg";

const squareImage = async (file: File): Promise<string> => {
  const { img } = await import("../inputs/image-tools");
  return img.presets.avatar(file);
};

/**
 * An image to pick: its preview (48 px), a button to choose or change it and one to remove it; a file dropped or
 * pasted on it counts as picked (the behaviour layer on the ui-sdk core). While the file is read, the choose button
 * turns busy; a file that cannot be read says so at the field.
 */
export const ImageInput = (props: ImageInputProps) => {
  const field = useField();
  field?.group();
  const t = useControlMessages();
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const value = () => props.value || null;
  const take = async (file: File | undefined) => {
    if (!file || busy()) return;
    setBusy(true);
    setFailed(false);
    try {
      props.onChange(await (props.transform ?? squareImage)(file));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const pick = useFilePick(() => ({
    accept: props.accept ?? imageAccept,
    disabled: props.disabled || busy(),
    name: props.name ?? field?.name,
    onValueChange: (files: File[]) => void take(files[0]),
    onReject: () => setFailed(true),
  }));
  return (
    <pick.Root class="k2-image" data-k2-part="ImageInput" role={field ? undefined : "group"} aria-label={field ? undefined : props.label}>
      <pick.Dropzone class="k2-image-preview" data-round={props.round ? "" : undefined}>
        <Show when={value()} fallback={<Icon name="photo" />}>
          {(source) => <img src={source()} alt="" />}
        </Show>
      </pick.Dropzone>
      <span class="k2-image-end">
        <pick.Trigger
          class="k2-btn"
          data-k2-part="Button"
          disabled={props.disabled}
          aria-busy={busy() ? "true" : undefined}
          data-busy={busy() ? "" : undefined}
          aria-describedby={field?.described}
        >
          <Icon name={value() ? "pencil" : "photo-plus"} />
          <span class="k2-btn-label">{value() ? t().changeImage : t().chooseImage}</span>
          <Show when={busy()}>
            <span class="k2-btn-busy" aria-hidden="true">
              <Icon name="loader-2" />
            </span>
          </Show>
        </pick.Trigger>
        <Show when={value()}>
          <Button
            variant="ghost"
            icon="trash"
            label={t().removeImage}
            disabled={props.disabled || busy()}
            onClick={() => props.onChange(null)}
          />
        </Show>
      </span>
      <pick.Input />
      <Show when={failed()}>
        <span class="k2-image-failed" role="alert">
          {t().imageFailed}
        </span>
      </Show>
    </pick.Root>
  );
};

export type SliderProps = {
  /** The number. With `onChange` the caller holds it; without, the slider keeps it. */
  value?: number;
  /** Called on every step of a drag or a key. */
  onChange?: (value: number) => void;
  /** Called once a drag or a key press ends, with the final number: for saving. */
  onCommit?: (value: number) => void;
  /** The smallest number (0 by default). */
  min?: number;
  /** The largest number (100 by default). */
  max?: number;
  /** The step between two numbers (1 by default). */
  step?: number;
  /** How the number reads at the end and for assistive technology, such as `{ style: "percent" }` or a unit. */
  format?: Intl.NumberFormatOptions;
  /** The name the number is sent under in a form; the field's name by default. */
  name?: string;
  /** A name when the slider stands without a Field. */
  label?: string;
  /** The number cannot be changed now: dimmed, the value still shown. */
  disabled?: boolean;
};

/**
 * A number on a range, such as a volume, a zoom or an opacity: a track with one round thumb in the control's 36 px, the
 * number as it reads at the end. Arrows, Page keys, Home and End move it; a phone's screen reader adjusts it with its
 * own gestures (the behaviour layer on the ui-sdk core).
 */
export const Slider = (props: SliderProps) => {
  const field = useField();
  const locale = useLocale();
  const range = useRange(() => ({
    ...(props.onChange ? { value: props.value ?? props.min ?? 0 } : { defaultValue: props.value ?? props.min ?? 0 }),
    onValueChange: (next: number) => props.onChange?.(next),
    onValueCommit: (next: number) => props.onCommit?.(next),
    min: props.min,
    max: props.max,
    step: props.step,
    format: props.format,
    locale: locale(),
    disabled: props.disabled,
    name: props.name ?? field?.name,
    thumbInputId: field?.control,
  }));
  return (
    <range.Root
      class="k2-slider"
      data-k2-part="Slider"
      data-disabled={props.disabled ? "" : undefined}
      aria-label={field ? undefined : props.label}
      aria-labelledby={field?.label}
      aria-describedby={field?.described}
    >
      <range.Control class="k2-slider-control">
        <range.Track class="k2-slider-track">
          <range.Indicator class="k2-slider-fill" />
        </range.Track>
        <range.Thumb class="k2-slider-thumb" />
      </range.Control>
      <range.Value class="k2-slider-value">{(state: { text?: string }) => state.text ?? ""}</range.Value>
      <range.Input />
    </range.Root>
  );
};

export type ColorInputProps = {
  /** The colour as `#rrggbb`. With `onChange` the caller holds it; without, the picker keeps it. */
  value?: string;
  /** Called on every change, with `#rrggbb`. */
  onChange?: (value: string) => void;
  /** Called once a drag, a typed colour or a press on a swatch ends: for saving. */
  onCommit?: (value: string) => void;
  /** Colours to pick at a press, such as the colours of the app's areas. */
  swatches?: readonly string[];
  /** The name the colour is sent under in a form; the field's name by default. */
  name?: string;
  /** A name when the picker stands without a Field. */
  label?: string;
  /** The colour cannot be changed now: dimmed, the colour still shown. */
  disabled?: boolean;
};

/**
 * A colour: its swatch and its code (any CSS colour typed in becomes `#rrggbb` on Enter), a surface of saturation and
 * brightness and a hue slider under it, and the given swatches; arrows move each thumb (the behaviour layer on the
 * ui-sdk core).
 */
export const ColorInput = (props: ColorInputProps) => {
  const field = useField();
  field?.group();
  const t = useControlMessages();
  const color = useColor(() => ({
    ...(props.onChange ? { value: props.value ?? "#000000" } : { defaultValue: props.value ?? "#000000" }),
    onValueChange: (next: string) => props.onChange?.(next),
    onValueCommit: (next: string) => props.onCommit?.(next),
    disabled: props.disabled,
    name: props.name ?? field?.name,
  }));
  return (
    <color.Root
      class="k2-color"
      data-k2-part="ColorInput"
      data-disabled={props.disabled ? "" : undefined}
      aria-label={field ? undefined : props.label}
    >
      <span class="k2-color-head">
        <color.Swatch class="k2-color-swatch" aria-hidden="true" />
        <span class="k2-input" data-disabled={props.disabled ? "" : undefined}>
          <color.Input id={field?.control} aria-label={t().colorCode} aria-describedby={field?.described} />
        </span>
      </span>
      <color.Area class="k2-color-area">
        <color.AreaThumb class="k2-color-thumb" aria-label={t().colorArea} />
      </color.Area>
      <color.Slider class="k2-color-hue" channel="hue">
        <color.SliderThumb class="k2-color-thumb" channel="hue" aria-label={t().hue} />
      </color.Slider>
      <Show when={props.swatches?.length}>
        <color.Swatches class="k2-color-swatches" aria-label={props.label ?? t().colorCode}>
          <For each={props.swatches}>
            {(swatch) => <color.SwatchItem class="k2-color-preset" value={swatch} aria-label={t().color({ value: swatch })} />}
          </For>
        </color.Swatches>
      </Show>
      <color.HiddenInput />
    </color.Root>
  );
};

export type DateInputProps = {
  /** The date as the person reads it, such as "27.11.2026". */
  value?: string;
  /** Called with the new text on every change. */
  onInput?: (value: string) => void;
  /** A quiet example date while the field is empty. */
  placeholder?: string;
  /** The name the value is sent under in a form; the field's name by default. */
  name?: string;
  /** A name when the date stands without a Field. */
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
  /** The words beside the box; they say what is turned on. */
  label: JSX.Element;
  /** The name the box is sent under in a form. */
  name?: string;
  /** Set, not set, or mixed (some of a group). */
  checked?: boolean | "mixed";
  /** A switch instead of a box: on and off take effect at once. */
  switch?: boolean;
  /** The box cannot be changed now: dimmed; its words say why. */
  disabled?: boolean;
  /** Called with the new state when a person changes it. */
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
  /** The name the choice is sent under in a form. */
  name: string;
  /** The few options, all visible: words, or a value with its words. */
  options: readonly (string | { value: string; label: string })[];
  /** The chosen value. */
  value?: string;
  /** The question of the choice when it stands without a Field: shown as the label line of a field of its own. */
  label?: string;
  /** Called with the value a person chose. */
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
