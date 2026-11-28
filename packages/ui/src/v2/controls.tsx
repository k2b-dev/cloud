import {
  createContext,
  createEffect,
  createRenderEffect,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  children as resolveChildren,
  Show,
  untrack,
  useContext,
} from "solid-js";
import { Dynamic, isServer } from "solid-js/web";
import { formatDateInput, parseDateInput } from "../inputs/date-input";
import { dateKey, isCalendarDay, isDateKey } from "../inputs/date-picker";
import { useLocale } from "../intl/locale";
import { addressKey, scanAddresses } from "./addresses";
import { useCode } from "./behavior/code";
import { useFilePick } from "./behavior/files";
import { usePopover } from "./behavior/overlays";
import { useColor, useRange } from "./behavior/pickers";
import { type ChoiceItem, useCombobox, useSelect } from "./behavior/select";
import { ActionButton, Button } from "./button";
import { useControlMessages } from "./control-messages";
import { useDateMessages } from "./date-messages";
import { DatePicker } from "./date-picker";
import { Avatar, Chip, custom, Icon } from "./marks";
import { useSettingMessages } from "./setting-messages";
import { textEdge } from "./tokens";
import type { Action, Person } from "./types";

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
export const Field = (props: FieldProps) => <FieldFrame field={props} />;

export type SettingProps = Omit<FieldProps, "optional" | "required"> & {
  /**
   * The value before an unsaved change, such as "12 Std.": the setting then says "geändert · vorher 12 Std." below
   * its control, so a page that saves as a whole shows what will change.
   */
  was?: string;
  /**
   * One quiet deed for this setting, such as "Auf Standard zurücksetzen" while the value differs from its default: a
   * text button at the end of the name's line, as `Field action` has it. The value's column keeps its place, so the
   * deed coming or going moves nothing.
   */
  action?: Action;
};

/**
 * One setting of a settings page: its name and a quiet hint on the left, the control beside them in a column of
 * 300 px, so the values stand in one line down the page and are read at a glance. On a narrow column the control
 * goes under the name. The control is the same as in a `Field`: `Input`, `Select`, `DateInput`, `Check` or `Choice`.
 */
export const Setting = (props: SettingProps) => {
  const t = useSettingMessages();
  // a changed setting says what it was below its control (inside the content, so the control keeps its place); made
  // here, so a page with plain fields loads neither the chip nor the catalog
  return (
    <FieldFrame
      field={props}
      setting
      was={
        <Show when={props.was}>
          {(before) => (
            <span class="k2-field-was">
              <Chip yours>{t().changedFrom({ value: before() })}</Chip>
            </span>
          )}
        </Show>
      }
    />
  );
};

const FieldFrame = (frame: { field: FieldProps & { was?: string; action?: Action }; setting?: boolean; was?: JSX.Element }) => {
  const props = frame.field;
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
  const part = frame.setting ? "Setting" : "Field";
  const setting = frame.setting ? "" : undefined;
  // the deed stands beside the name, never in it: a button inside a <label> would be pressed with it. It comes before
  // the control, as it stands, so Tab reaches the name's deed and then the value (the grid places both)
  const deed = (
    <Show when={props.action}>
      {(action) => (
        <span class="k2-field-action">
          <ActionButton action={action()} variant="text" />
        </span>
      )}
    </Show>
  );
  const was = frame.was;
  // A group of choices is named by its label line; one control is labelled by it.
  return grouped ? (
    <div
      class="k2-field"
      data-k2-part={part}
      data-setting={setting}
      data-action={props.action ? "" : undefined}
      data-was={props.was ? "" : undefined}
      role="group"
      aria-labelledby={label}
    >
      <span class="k2-field-label" id={label}>
        {labelLine}
      </span>
      {deed}
      {content}
      {was}
      {messageLine}
    </div>
  ) : named ? (
    <div
      class="k2-field"
      data-k2-part={part}
      data-setting={setting}
      data-action={props.action ? "" : undefined}
      data-was={props.was ? "" : undefined}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: a pointer shortcut like a native label's; the control it names is the keyboard target. A <label for> would press the button and open its list. */}
      <span class="k2-field-label" id={label} onClick={() => named?.()}>
        {labelLine}
      </span>
      {deed}
      {content}
      {was}
      {messageLine}
    </div>
  ) : (
    <div
      class="k2-field"
      data-k2-part={part}
      data-setting={setting}
      data-action={props.action ? "" : undefined}
      data-was={props.was ? "" : undefined}
    >
      <label class="k2-field-label" id={label} for={control}>
        {labelLine}
      </label>
      {deed}
      {content}
      {was}
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

type InputBase = {
  /** The text in the field. */
  value?: string;
  /** A quiet example while the field is empty. */
  placeholder?: string;
  /**
   * The kind of text, which picks the phone's keyboard; `text` when not set. The search of a head is `HeadSearch`,
   * which brings its symbol, "/" and its words along. A plain `search` in a head keeps its field from 768 px; on the
   * phone, where the other head actions hide, it stands as its symbol, and a tap goes into the field, which opens over
   * the head while it has the focus and folds back, its words kept, when the focus leaves or on Escape (unless
   * `onKeyDown` takes Escape itself with `preventDefault`). Where a host offers the
   * page's search in a bar of its own (`data-k2-host-search` on the v2 scope, as the Cloud shell's phone bar does),
   * the folded search leaves the head and the order of the Tab key on the phone, and the host focuses it; a head with
   * a path then opens it over the content's first row.
   */
  type?: "text" | "email" | "number" | "search" | "tel" | "url" | "password";
  /** A Tabler icon before the text, such as `search`. */
  icon?: string;
  /** A text of several lines: it shows `rows` lines at least and grows with its words up to ten lines, then scrolls. */
  multiline?: boolean;
  /** The lines a multi-line field shows at least; 3 (80 px) when not set. */
  rows?: number;
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
  /**
   * What the browser and a password manager may fill in, such as `username`, `current-password`, `new-password`,
   * `one-time-code` or `off`. It stands in the server's markup, where a password manager reads it.
   */
  autocomplete?: JSX.InputHTMLAttributes<HTMLInputElement>["autocomplete"];
  /** The most characters the field takes. */
  maxLength?: number;
  /** The keyboard a phone shows, such as `numeric` for a code or `email`; the kind of text (`type`) stays. */
  inputMode?: "none" | "text" | "decimal" | "numeric" | "tel" | "search" | "email" | "url";
  /** Whether the browser marks misspelt words; `false` for names, codes, keys and addresses. */
  spellcheck?: boolean;
  /** Whether a phone's keyboard starts words or sentences with a capital; `off` for names, codes and keys. */
  autocapitalize?: "off" | "none" | "on" | "sentences" | "words" | "characters";
};

/**
 * The rows a text of several lines asks for: the lines of its value, at least its `rows` (3) and at most ten. Where
 * the browser cannot size it to its words, these rows give it its height from the server's page on, so a long value
 * does not make it grow when the page comes alive; lines that wrap are added by `followText` then.
 */
const rowsFor = (value: string | undefined, rows = 3) => Math.max(rows, Math.min(10, (value ?? "").split("\n").length));

/** Whether the browser sizes a text of several lines to its words itself (CSS `field-sizing`, as v2.css asks). */
const sizesToText = () => typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

/**
 * Where the browser cannot, the height of a text of several lines follows its words: as you type, when its value
 * changes and when its width does (the way core's textarea does it). v2.css bounds it between `rows` and ten lines.
 */
const followText = (area: HTMLTextAreaElement, value: () => string | undefined) => {
  let disposed = false;
  const fit = () => {
    // a fit queued before the field left (a dialog that closes on save) has nothing to measure any more
    if (disposed || !area.isConnected) return;
    // For the moment of measuring, the field is at its least height, and a browser would pull every scroll above it
    // back to fit; each keeps where it was (the page too).
    const scrolls: [Element, number][] = [];
    for (let node = area.parentElement; node; node = node.parentElement) if (node.scrollTop > 0) scrolls.push([node, node.scrollTop]);
    const page = document.scrollingElement;
    if (page && page.scrollTop > 0 && !scrolls.some(([node]) => node === page)) scrolls.push([page, page.scrollTop]);
    // measured from its minimum (v2.css: `rows` lines), not from its height now: `auto` would keep the rows the
    // server asked for its first value, and a field emptied later would stay that high
    area.style.height = "0px";
    area.style.height = `${area.scrollHeight}px`;
    for (const [node, top] of scrolls) node.scrollTop = top;
  };
  createEffect(on(value, () => queueMicrotask(fit)));
  area.addEventListener("input", fit);
  let width = -1;
  const sizes = new ResizeObserver(([entry]) => {
    if (!entry || entry.contentRect.width === width) return;
    width = entry.contentRect.width;
    fit();
  });
  sizes.observe(area);
  onCleanup(() => {
    disposed = true;
    area.removeEventListener("input", fit);
    sizes.disconnect();
  });
};

/** Where a search sends its text (see `InputProps.send`). */
export type InputSend = {
  /** The page the search loads, such as `/app/accounts/groups`. */
  action: string;
  /** The rest of the address that the search keeps, as name and value; the field's own name is left out. */
  params?: Iterable<readonly [string, string]>;
  /** Searches in place with the text, where JavaScript runs; without it the page loads. */
  onSearch?: (text: string) => void;
};

export type InputProps = InputBase &
  (
    | { send?: undefined }
    | {
        /**
         * A search that reaches the server also without JavaScript (with `type="search"`): the field is its own GET
         * form, named by `label`, and Enter loads `action` with `params` (the rest of the address, such as a list's
         * filters) and the text under `name`, which it needs. Where JavaScript runs, `onSearch` takes Enter instead and
         * the page searches in place. The field keeps its place and look, also in a head and folded on the phone. Never
         * put it inside another `<form>`: forms do not nest, and the browser drops the inner one.
         */
        send: InputSend;
        /** The name the search text is sent under, such as `q`. */
        name: string;
      }
  );

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

/**
 * Whether a search is the head's search that a host's bar opens on the phone (`data-k2-host-search`): folded away,
 * it leaves the order of the Tab key, so the bar's button is its one way in; the host still focuses it. Known in the
 * browser only, after the first render, which stays the server's.
 */
const useHostedHeadSearch = (input: () => HTMLInputElement | undefined, search: () => boolean) => {
  const [hosted, setHosted] = createSignal(false);
  onMount(() => {
    const place = input()?.parentElement?.parentElement;
    if (!search() || !place?.matches('[data-k2-host-search] [data-slot="head"] > .k2-bar > .k2-bar-end')) return;
    const phone = matchMedia(`not all and (min-width: ${textEdge.phoneBelow}px)`);
    const update = () => setHosted(phone.matches);
    update();
    phone.addEventListener("change", update);
    onCleanup(() => phone.removeEventListener("change", update));
  });
  return hosted;
};

/**
 * What `HeadSearch` adds to the `Input` it places (`head-search.tsx`): the marks, handlers and `ref` of the field's
 * box, for the head's search as its symbol, its overlay, "/", its words and its held menu. It comes through this
 * context, so an `Input` elsewhere carries none of its code.
 */
export type HeadSearchKit = (props: InputProps, end: () => unknown) => JSX.HTMLAttributes<HTMLElement> | undefined;
export const HeadSearchContext = createContext<HeadSearchKit>();

/** A round text field: 36 px, 1 px edge, a blue ring on focus. In a field it takes its name and error. */
export const Input = (props: InputProps) => {
  const field = useField();
  let input: HTMLInputElement | undefined;
  const hosted = useHostedHeadSearch(
    () => input,
    () => props.type === "search",
  );
  // a head's search takes its kit before its end is made, so a search inside that end finds it taken
  const head = props.type === "search" ? useContext(HeadSearchContext)?.(props, () => end()) : undefined;
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
    // written as attributes, so the first markup from the server already carries them (password managers read it)
    autocomplete: props.autocomplete,
    maxlength: props.maxLength,
    inputmode: props.inputMode,
    spellcheck: props.spellcheck === undefined ? undefined : props.spellcheck ? ("true" as const) : ("false" as const),
    autocapitalize: props.autocapitalize,
  });
  // a search sent to the server is its own GET form, with the same class and marks, so every rule of a head holds
  const send = () => (props.type === "search" ? props.send : undefined);
  const kept = () => {
    const own = props.name ?? field?.name;
    return [...(send()?.params ?? [])].filter(([name]) => name !== own);
  };
  return (
    <Dynamic
      {...head}
      component={send() ? "form" : "span"}
      method={send() ? "get" : undefined}
      action={send()?.action}
      role={send() ? "search" : undefined}
      // two searches on a page are two landmarks; each is named by its field's label
      aria-label={send() ? props.label : undefined}
      onSubmit={(event: SubmitEvent) => {
        const search = send()?.onSearch;
        if (!search) return;
        event.preventDefault();
        search(input?.value ?? "");
      }}
      class="k2-input"
      data-k2-part="Input"
      data-invalid={field?.invalid ? "" : undefined}
      data-disabled={props.disabled ? "" : undefined}
      data-multiline={props.multiline ? "" : undefined}
      data-search={props.type === "search" ? "" : undefined}
      style={props.multiline && props.rows !== undefined ? custom({ "--k2-rows": String(props.rows) }) : undefined}
    >
      <Show when={props.icon}>{(name) => <Icon name={name()} />}</Show>
      <For each={kept()}>{([name, value]) => <input type="hidden" name={name} value={value} />}</For>
      <Show
        when={props.multiline}
        fallback={
          <input
            {...shared()}
            ref={(element) => {
              input = element;
              forwardRef(props.ref, element);
            }}
            tabIndex={hosted() ? -1 : undefined}
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
          rows={rowsFor(props.value, props.rows)}
          ref={(element) => {
            forwardRef(props.ref, element);
            if (!sizesToText()) followText(element, () => props.value);
          }}
          onInput={(event) => props.onInput?.(event.currentTarget.value)}
          onKeyDown={(event) => props.onKeyDown?.(event)}
        >
          {isServer ? `\n${props.value ?? ""}` : undefined}
        </textarea>
      </Show>
      <Show when={end() !== undefined}>
        <span class="k2-input-end">{end()}</span>
      </Show>
    </Dynamic>
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
  /**
   * `email`: e-mail addresses, as the To of a message. A comma, a semicolon or a new line ends an address too, a
   * paste of several becomes several chips (`Name <address>` and `"Berg, Anna" <address>` as well), and a text that is
   * no address stays in the field with a sentence why, and keeps the form from being sent. A value is the address in
   * the form it was given (`Name <address>`); the same address twice, in any case, is one chip. The phone shows its
   * keyboard for addresses.
   */
  type?: "email";
  /** How many values the field takes; more are not added, and a sentence says so. With `email` 200 (one To of Mail). */
  max?: number;
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
  const email = () => props.type === "email";
  // the text being typed; with `email` it is held here, so a separator or a paste can turn it into chips
  const [query, setQuery] = createSignal("");
  // What the field says under its chips: a text that is no address (it keeps the form from being sent) and values it
  // left out over `max`, each a sentence of its own; and what assistive technology hears of a change.
  const [refused, setRefused] = createSignal<string>();
  const [overflow, setOverflow] = createSignal<string>();
  const [heard, setHeard] = createSignal("");
  const rejected = () => refused() !== undefined;
  const noticeId = createUniqueId();
  // a status says each change, also the same words twice: it is emptied first, so the new words are a change
  const say = (words: string) => {
    setHeard("");
    queueMicrotask(() => setHeard(words));
  };
  const max = () => props.max ?? (email() ? 200 : Number.POSITIVE_INFINITY);
  const keyOf = (value: string) => (email() ? addressKey(value) : value);
  // the values as the field holds them: trimmed, each once, at most `max` (for every kind of value)
  const commit = (next: string[]) => {
    const seen = new Set<string>();
    const clean = next
      .map((value) => value.trim())
      .filter((value) => {
        const key = keyOf(value);
        if (!value || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const kept = clean.slice(0, max());
    const left = clean.length - kept.length;
    setOverflow(left > 0 ? (email() ? t().tooManyAddresses({ max: max(), left }) : t().tooManyValues({ max: max(), left })) : undefined);
    if (email() && kept.length < values().length) say(t().addressesRemoved({ count: values().length - kept.length }));
    else if (email() && kept.length > values().length) say(t().addressesAdded({ count: kept.length - values().length }));
    setOwn(kept);
    props.onChange?.(kept);
  };
  // The addresses in a text become chips. While typing (not `final`) only entries a separator closed are taken, and
  // a text with no address yet is left as it is typed; Enter, a paste and leaving the field take the last entry too,
  // and what is no address then stays in the field with a sentence why.
  const take = (text: string, final: boolean) => {
    const { found, rest } = scanAddresses(text, { final });
    if (!found.length && !final) {
      setQuery(text);
      setRefused(undefined);
      return;
    }
    if (found.length) commit([...values(), ...found]);
    setQuery(rest);
    // cut by characters, so a long text never ends in half an emoji
    const letters = Array.from(rest);
    const shown = letters.length > 60 ? `${letters.slice(0, 59).join("")}…` : rest;
    setRefused(final && rest ? t().notAnAddress({ text: shown }) : undefined);
  };
  const items = (): ChoiceItem[] => [...new Set([...(props.suggestions ?? []), ...values()])].map((value) => ({ value, label: value }));
  // the core's input owns its id, so the field's label names it through aria-labelledby; a press on the label focuses it
  let input: HTMLInputElement | undefined;
  field?.named(() => input?.focus());
  // a refused text keeps the form from being sent, with the field's own sentence as the reason
  createRenderEffect(() => {
    // read before the input is there too, so the effect follows the sentence from the start
    const reason = refused() ?? "";
    input?.setCustomValidity(reason);
  });
  // Without `onChange` the given values are where a form's reset returns to. The values are held here for every kind
  // (core only shows them), so `max` holds for what core keeps too, and the field puts them back itself.
  const initial = [...(props.value ?? [])];
  let chips: HTMLElement | undefined;
  const ours = (event: Event) => event.target instanceof HTMLFormElement && !!chips && event.target.contains(chips);
  const onReset = (event: Event) => {
    if (props.onChange || !ours(event)) return;
    setOwn(initial);
    setQuery("");
    setRefused(undefined);
    setOverflow(undefined);
  };
  // Sending while the focus is still in the field takes the typed addresses first, as leaving it would; a text that
  // is no address then keeps the form from being sent, with its sentence.
  const onSubmit = (event: Event) => {
    if (!email() || !ours(event) || !query().trim()) return;
    take(query(), true);
    if (!rejected()) return;
    event.preventDefault();
    event.stopPropagation();
    input?.reportValidity();
  };
  // leaving the field and its suggestions takes the last entry, as Enter does (a press outside too: core keeps the text)
  const onLeave = (event: FocusEvent) => {
    const to = event.relatedTarget;
    const list = input?.getAttribute("aria-controls");
    const popup = list ? document.getElementById(list) : null;
    if (to instanceof Node && (chips?.contains(to) || popup?.contains(to))) return;
    if (query().trim()) take(query(), true);
  };
  onMount(() => {
    document.addEventListener("reset", onReset);
    document.addEventListener("submit", onSubmit, true);
    onCleanup(() => {
      document.removeEventListener("reset", onReset);
      document.removeEventListener("submit", onSubmit, true);
    });
  });
  const combo = useCombobox(() => ({
    items: items(),
    multiple: true as const,
    allowCustomValue: true,
    // the values are held here: a paste adds several at once, and `max` leaves nothing in core that does not show
    value: values(),
    // typing: a separator turns the addresses before it into chips; anything else is typed on, and the sentence of a
    // refused text goes while it is fixed
    ...(email()
      ? {
          query: query(),
          keepQuery: true,
          onQueryChange: (next: string) => {
            if (/[,;\n]/.test(next)) return take(next, false);
            setQuery(next);
            if (rejected()) setRefused(undefined);
          },
        }
      : {}),
    onValueChange: (next: string[]) => {
      if (!email()) return commit(next);
      // Enter commits the typed text: as addresses, the rest stays in the field
      const added = next.filter((value) => !values().includes(value));
      if (next.length < values().length || !added.length) return commit(next);
      take(added.join(", "), true);
    },
    disabled: props.disabled,
    required: field?.required,
    name: props.name ?? field?.name,
  }));
  return (
    <>
      <combo.Chips
        ref={(element: HTMLElement) => {
          chips = element;
          if (email()) element.addEventListener("focusout", onLeave);
        }}
        class="k2-input"
        data-k2-part="TagsInput"
        data-tags=""
        aria-labelledby={field?.label}
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
          ref={(element: HTMLElement) => {
            input = element as HTMLInputElement;
          }}
          placeholder={values().length ? undefined : props.placeholder}
          aria-labelledby={field?.label}
          aria-label={field ? undefined : props.label}
          aria-invalid={field?.invalid || rejected() ? "true" : undefined}
          aria-describedby={[field?.described, refused() || overflow() ? noticeId : undefined].filter(Boolean).join(" ") || undefined}
          inputMode={email() ? "email" : undefined}
          autocomplete={email() ? "email" : undefined}
          onPaste={(event: ClipboardEvent) => {
            const text = event.clipboardData?.getData("text/plain") ?? "";
            if (!email() || !/[,;\s]/.test(text.trim()) || !input) return;
            event.preventDefault();
            // the pasted text stands where the selection was, as a plain paste would put it
            const typed = input.value;
            const from = input.selectionStart ?? typed.length;
            const to = input.selectionEnd ?? from;
            take(typed.slice(0, from) + text + typed.slice(to), true);
          }}
        />
      </combo.Chips>
      {/* why a text was not taken, under the chips; a refused text keeps the form from being sent */}
      <Show when={refused() || overflow()}>
        <span class="k2-field-message" id={noticeId} data-error={refused() ? "" : undefined}>
          {[refused(), overflow()].filter(Boolean).join(" ")}
        </span>
      </Show>
      <Show when={email()}>
        <span class="k2-hidden-text" role="status">
          {heard()}
        </span>
      </Show>
      {/* core's form input validates and resets the field; the values are sent one entry each under the name */}
      <combo.FormInput />
      <Show when={props.name ?? field?.name}>
        {(name) => <For each={values()}>{(value) => <input type="hidden" name={name()} value={value} disabled={props.disabled} />}</For>}
      </Show>
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
  // The last pick wins: a file picked while an earlier one is still read replaces it, and the earlier one's value is
  // dropped when it arrives, so the image shown, the value sent and "Bild gewählt" all name the same file.
  let picks = 0;
  const take = async (file: File | undefined) => {
    if (!file) return;
    const mine = ++picks;
    setBusy(true);
    setFailed(false);
    try {
      const made = await (props.transform ?? squareImage)(file);
      if (mine === picks) props.onChange(made);
    } catch {
      if (mine === picks) setFailed(true);
    } finally {
      if (mine === picks) setBusy(false);
    }
  };
  // The file input only picks: it has no name, so a form never sends the file itself, and it is required only while
  // there is no image yet. What the form sends is the value, in a hidden input under the name.
  const pick = useFilePick(() => ({
    accept: props.accept ?? imageAccept,
    // not disabled while a picked file is read: a disabled input is left out of the form's checks, so a required
    // field would let the form go without its image (a second pick meanwhile replaces the first, see `take`)
    disabled: props.disabled,
    required: (field?.required && !value()) || undefined,
    onValueChange: (files: File[]) => void take(files[0]),
    onReject: () => setFailed(true),
    announcement: (change) => (change.added.length ? t().imageChosen : change.rejected.length ? t().imageFailed : null),
  }));
  const name = () => props.name ?? field?.name;
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
      <Show when={name()}>{(sent) => <input type="hidden" name={sent()} value={value() ?? ""} disabled={props.disabled} />}</Show>
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
  /** A unit the number format has no word for, such as `px`: it reads after the number, also for assistive technology. */
  unit?: string;
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
  const initial = props.value ?? props.min ?? 0;
  const withUnit = (text: string) => (props.unit && text ? `${text} ${props.unit}` : text);
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
        <range.Thumb
          class="k2-slider-thumb"
          input={{
            valueText: (attrs: Record<string, unknown>) => withUnit(String(attrs["aria-valuetext"] ?? attrs["aria-valuenow"] ?? "")),
            get "aria-describedby"() {
              return field?.described;
            },
            get "aria-invalid"() {
              return field?.invalid ? "true" : undefined;
            },
            // a form's reset returns a native range input to its default; the default is the slider's first value, so
            // the input, the number shown and the value sent come back together
            ref: (element: HTMLElement) => {
              (element as HTMLInputElement).defaultValue = String(initial);
            },
          }}
        />
      </range.Control>
      <range.Value class="k2-slider-value">{(state: { text?: string }) => withUnit(state.text ?? "")}</range.Value>
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
  const picker = usePopover(() => ({}));
  // the code beside the swatch describes it: the swatch is named for its deed and says which colour it holds
  const code = field?.control ?? createUniqueId();
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
        {/* the colour as a swatch that opens the picker (area and hue) on a panel: a settings row stays one line */}
        <picker.Trigger class="k2-color-swatch" disabled={props.disabled} aria-label={t().pickColor} aria-describedby={code}>
          <color.Swatch class="k2-color-fill" aria-hidden="true" />
        </picker.Trigger>
        <span class="k2-input" data-disabled={props.disabled ? "" : undefined}>
          <color.Input id={code} aria-label={t().colorCode} aria-describedby={field?.described} />
        </span>
      </span>
      <picker.Popup class="k2-pop k2-color-pop" data-k2-part="Popover" side="bottom" align="start" sideOffset={4} collisionPadding={8}>
        <color.Area class="k2-color-area">
          <color.AreaThumb class="k2-color-thumb" aria-label={t().colorArea} valueText={(attrs) => t().areaValue(areaPercents(attrs))} />
        </color.Area>
        <color.Slider class="k2-color-hue" channel="hue">
          <color.SliderThumb
            class="k2-color-thumb"
            channel="hue"
            aria-label={t().hue}
            valueText={(attrs) => t().hueValue({ degrees: Math.round(Number(attrs["aria-valuenow"] ?? 0)) })}
          />
        </color.Slider>
      </picker.Popup>
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

/**
 * Saturation and brightness in percent, read from where core puts the thumb of the colour surface (`--area-x` and
 * `--area-y`, fractions of the surface): the words follow the colour core holds, also on black or white.
 */
const areaPercents = (attrs: Record<string, unknown>) => {
  const style = typeof attrs.style === "string" ? attrs.style : "";
  // the whole value up to the next declaration, read as a number (core may write 1e-7)
  const fraction = (axis: "x" | "y") => {
    const value = Number(new RegExp(`--area-${axis}:([^;]+)`).exec(style)?.[1]?.trim());
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  };
  return { saturation: Math.round(fraction("x") * 100), brightness: Math.round(fraction("y") * 100) };
};

export type DateInputProps = {
  /** The date as a date key ("2026-12-15") or as the locale writes it ("15.12.2026"); the field shows the second. */
  value?: string;
  /**
   * A picked or typed date as a date key ("2026-12-15"), or "" when the field was emptied. Typed text applies on Enter
   * or when the field is left; text that is no date marks the field and applies nothing.
   */
  onInput?: (value: string) => void;
  /** A quiet example date while the field is empty. */
  placeholder?: string;
  /** The name a form sends the date key under; the field's name by default. */
  name?: string;
  /** A name when the date stands without a Field. */
  label?: string;
  /**
   * The zone that says which day today is, for words such as "heute" or "+3" and the calendar's today; "UTC" by
   * default. Give the person's zone, the same on the server and in the island, as for `FilterBar`.
   */
  timeZone?: string;
};

/**
 * A date field: the date typed in the order of the locale ("24.11.2026", also "heute", "+3", "Mi"), and the calendar
 * symbol at its end opens `DatePicker` below it. Picking a day fills the field and gives the focus back to it.
 */
export const DateInput = (props: DateInputProps) => {
  const field = useField();
  const locale = useLocale();
  const t = useDateMessages();
  // today in one zone on the server and in the browser, so "heute" names the same day on both sides
  const today = () => dateKey(new Date(), { timeZone: props.timeZone ?? "UTC" });
  /** A date key for a value, or `undefined` when it is no readable date (also a key of a day that does not exist). */
  const keyOf = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    if (isDateKey(value)) return isCalendarDay(value) ? value : undefined;
    const read = parseDateInput(value, { today: today(), locale: locale() });
    return read.kind === "date" ? read.date : undefined;
  };
  const shown = (value: string | undefined) => (value && isCalendarDay(value) ? formatDateInput(value, locale()) : (value ?? ""));
  // Without `onInput` the field keeps what was picked or typed itself, so it always shows the date it holds.
  const [own, setOwn] = createSignal(props.value);
  createRenderEffect(() => setOwn(props.value));
  const [text, setText] = createSignal(shown(props.value));
  createRenderEffect(() => setText(shown(own())));
  const [unreadable, setUnreadable] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  let input: HTMLInputElement | undefined;
  const take = (key: string) => {
    setUnreadable(false);
    setOwn(key);
    setText(shown(key));
    props.onInput?.(key);
  };
  const commit = (typed: string) => {
    if (!typed.trim()) {
      if (keyOf(own()) !== undefined || own()) take("");
      setUnreadable(false);
      return;
    }
    const key = keyOf(typed);
    if (key === undefined) {
      setUnreadable(true);
      return;
    }
    if (key !== keyOf(own())) take(key);
    else {
      setUnreadable(false);
      setText(shown(key));
    }
  };
  const popover = usePopover(() => ({ open: open(), onOpenChange: setOpen }));
  const invalid = () => field?.invalid || unreadable();
  // text that is no date makes the form invalid too, so it never sends the date the field held before
  // (the message is read before the element is there, so the effect follows it from the start)
  createRenderEffect(() => {
    const message = unreadable() ? t().unreadable : "";
    input?.setCustomValidity(message);
  });
  return (
    <span class="k2-input" data-k2-part="DateInput" data-invalid={invalid() ? "" : undefined}>
      <input
        ref={input}
        id={field?.control}
        type="text"
        inputmode="numeric"
        autocomplete="off"
        value={text()}
        placeholder={props.placeholder}
        aria-label={field ? undefined : props.label}
        aria-invalid={invalid() ? "true" : undefined}
        aria-describedby={field?.described}
        title={unreadable() ? t().unreadable : undefined}
        required={field?.required || undefined}
        onInput={(event) => setText(event.currentTarget.value)}
        onChange={(event) => commit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.isComposing) commit(event.currentTarget.value);
          if (event.key === "ArrowDown" && event.altKey) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      />
      <Show when={props.name ?? field?.name}>{(name) => <input type="hidden" name={name()} value={keyOf(own()) ?? own() ?? ""} />}</Show>
      <span class="k2-input-end">
        <popover.Trigger
          class="k2-btn"
          data-k2-part="Button"
          data-variant="ghost"
          data-icon-only=""
          aria-label={t().openCalendar}
          title={t().openCalendar}
        >
          <Icon name="calendar" />
        </popover.Trigger>
      </span>
      <popover.Popup class="k2-pop k2-dpop" data-k2-part="Popover" side="bottom" align="end" sideOffset={4} collisionPadding={8}>
        <DatePicker
          value={keyOf(own())}
          timeZone={props.timeZone ?? "UTC"}
          label={props.label}
          autoFocus
          onPick={(key) => {
            take(key);
            setOpen(false);
            input?.focus({ preventScroll: true });
          }}
        />
      </popover.Popup>
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
  /** A quiet line under the words, such as what turning it on does; assistive technology reads it with the box. */
  description?: string;
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
  const id = createUniqueId();
  const described = `${id}-description`;
  const named = `${id}-label`;
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
          // with a description inside the label, the box takes its name from its words alone: the line describes it
          aria-labelledby={props.description ? named : undefined}
          aria-describedby={[field?.described, props.description ? described : undefined].filter(Boolean).join(" ") || undefined}
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
      <span class="k2-choice-text">
        <Show when={props.description} fallback={props.label}>
          {(text) => (
            <>
              <span id={named}>{props.label}</span>
              <span class="k2-choice-description" id={described}>
                {text()}
              </span>
            </>
          )}
        </Show>
      </span>
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
    /** `false`: out of the tab order, where the thing around it takes the focus and Space (a tile of a grid). */
    focusable?: false;
  },
) => (
  <span class="k2-mark">
    <input
      class="k2-mark-input"
      type="checkbox"
      aria-label={props.label}
      aria-labelledby={props.labelledBy}
      tabindex={props.focusable === false ? -1 : undefined}
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

/** An option of a `Choice`: words, or a value with its words and, for a person, their face before the words. */
export type ChoiceOption = string | { value: string; label: string; person?: Person };

export type ChoiceProps = {
  /** The name the choice is sent under in a form. */
  name: string;
  /** The few options, all visible: words, or a value with its words (and a `person` whose face leads them). */
  options: readonly ChoiceOption[];
  /** The question of the choice when it stands without a Field: shown as the label line of a field of its own. */
  label?: string;
  /** The choice cannot be changed now: every option dimmed, the chosen one still shown. */
  disabled?: boolean;
} & (
  | {
      multiple?: false;
      /** The chosen value. */
      value?: string;
      /** Called with the value a person chose. */
      onChange?: (value: string) => void;
    }
  | {
      /** Several options may be chosen: boxes instead of points; the form sends one entry per chosen value. */
      multiple: true;
      /** The chosen values. */
      value?: readonly string[];
      /** Called with all chosen values after each change. */
      onChange?: (values: string[]) => void;
    }
);

/**
 * A few visible options, one of which is chosen: round points, each on one 20 px text line; with `multiple` boxes,
 * several of which are chosen. An option for a person leads with their face (20 px), and is named by its words alone.
 * With a `label` and no Field around it, it stands in a field of its own, so its question is visible and names the
 * group.
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
  const t = useControlMessages();
  const options = () => props.options.map((option) => (typeof option === "string" ? { value: option, label: option } : option));
  const given = (): readonly string[] => (props.multiple ? (props.value ?? []) : props.value === undefined ? [] : [props.value]);
  // the values the choice started with: a form's reset puts them back (the inputs' default, and what the choice holds)
  const initial = untrack(given);
  const [own, setOwn] = createSignal<readonly string[]>(initial);
  const chosen = () => (props.onChange ? given() : own());
  const choose = (value: string, on: boolean) => {
    if (props.multiple) {
      const next = on ? [...chosen().filter((each) => each !== value), value] : chosen().filter((each) => each !== value);
      const ordered = options()
        .map((option) => option.value)
        .filter((each) => next.includes(each));
      setOwn(ordered);
      props.onChange?.(ordered);
    } else {
      setOwn([value]);
      props.onChange?.(value);
    }
  };
  let group: HTMLDivElement | undefined;
  const onReset = (event: Event) => {
    if (!(event.target instanceof HTMLFormElement) || !group || !event.target.contains(group)) return;
    setOwn(initial);
    // A choice the page holds stays as the page holds it: the reset puts the inputs back to their defaults, so one
    // task later they show the page's choice again, and the form sends what the page holds.
    const inputs = group;
    if (props.onChange)
      setTimeout(() => {
        // a group that left before the task (a dialog that closes on reset) has no inputs to set any more
        if (!inputs.isConnected) return;
        for (const input of inputs.querySelectorAll<HTMLInputElement>("input.k2-mark-input"))
          input.checked = chosen().includes(input.value);
      });
  };
  onMount(() => {
    document.addEventListener("reset", onReset);
    onCleanup(() => document.removeEventListener("reset", onReset));
  });
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is group or radiogroup, and both are named
    <div
      ref={group}
      class="k2-choices"
      data-k2-part="Choice"
      role={props.multiple ? "group" : "radiogroup"}
      aria-label={field ? undefined : props.label}
      aria-labelledby={field?.label}
      aria-describedby={field?.described}
      aria-disabled={props.disabled ? "true" : undefined}
    >
      <For each={options()}>
        {(option, index) => {
          const on = () => chosen().includes(option.value);
          return (
            <label class="k2-choice" data-disabled={props.disabled ? "" : undefined}>
              <span class="k2-mark">
                <input
                  class="k2-mark-input"
                  type={props.multiple ? "checkbox" : "radio"}
                  name={props.name}
                  value={option.value}
                  checked={on()}
                  // points: the group is required; boxes: while none is chosen the first one says "choose at least one",
                  // so the form asks for one, and no box sounds mandatory on its own
                  required={(field?.required && !props.multiple) || undefined}
                  ref={(input: HTMLInputElement) => {
                    input.defaultChecked = initial.includes(option.value);
                    // the box that is first now: options that change their order hand the sentence on
                    if (props.multiple)
                      createRenderEffect(() =>
                        input.setCustomValidity(index() === 0 && field?.required && chosen().length === 0 ? t().chooseOne : ""),
                      );
                  }}
                  disabled={props.disabled}
                  onChange={(event) => choose(option.value, event.currentTarget.checked)}
                />
                <Show when={props.multiple} fallback={<span class="k2-radio" data-checked={on() ? "" : undefined} data-k2-mark="" />}>
                  <span class="k2-check" data-checked={on() ? "" : undefined} data-k2-mark="">
                    <Show when={on()}>
                      <Icon name="check" />
                    </Show>
                  </span>
                </Show>
              </span>
              <Show when={"person" in option && option.person}>{(person) => <Avatar {...person()} decorative />}</Show>
              <span class="k2-choice-text">{option.label}</span>
            </label>
          );
        }}
      </For>
    </div>
  );
};
