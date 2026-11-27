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
import { ActionButton } from "./button";
import { useControlMessages } from "./control-messages";
import { Avatar, custom, Icon } from "./marks";
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

export const useField = () => useContext(FieldContext);

type InputBase = {
  /** The text in the field. */
  value?: string;
  /** A quiet example while the field is empty. */
  placeholder?: string;
  /**
   * The kind of text, which picks the phone's keyboard; `text` when not set. A `search` in the head of a workspace
   * or pane stays on the phone as its symbol (36 px, like an icon button), where the other head actions hide: a tap
   * goes into the field, which opens over the head while it has the focus and folds back, its words kept, when the
   * focus leaves or on Escape (unless `onKeyDown` takes Escape itself with `preventDefault`). Where a host offers the
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
  const fit = () => {
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

/** A round text field: 36 px, 1 px edge, a blue ring on focus. In a field it takes its name and error. */
export const Input = (props: InputProps) => {
  const field = useField();
  let input: HTMLInputElement | undefined;
  const hosted = useHostedHeadSearch(
    () => input,
    () => props.type === "search",
  );
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
