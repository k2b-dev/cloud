import { createEffect, createSignal, For, type JSX, Show } from "solid-js";
import { createFieldMeta, Field, fieldControlAria } from "../internal/field";
import { useUiMessages } from "../intl/messages";
import { type ChoiceOption, createChoiceLoader, createChoicePopover, nextEnabledChoiceIndex } from "./choice";
import type { FieldProps, MaybeAccessor } from "./field-contract";
import { resolveMaybeAccessor } from "./field-contract";
import { useSelectMessages } from "./select-messages";

export type ComboboxOption = { id: string; label: string; description?: string; icon?: string };
export type ComboboxProps = FieldProps & {
  readOnly?: boolean;
  query?: MaybeAccessor<string>;
  onQueryChange?: (query: string) => void;
  placeholder?: string;
  fetchData: (query: string, signal: AbortSignal) => Promise<ComboboxOption[]>;
  onSelect: (option: ComboboxOption) => void;
  debounceMs?: number;
};

const iconClass = (icon: string) => (icon.split(/\s+/).includes("ti") ? icon : `ti ${icon}`);

export function Combobox(props: ComboboxProps): JSX.Element {
  const messages = useUiMessages();
  const selectMessages = useSelectMessages();
  const meta = createFieldMeta(props.id);
  const listboxId = `${meta.controlId}-listbox`;
  const [localQuery, setLocalQuery] = createSignal("");
  const query = () => resolveMaybeAccessor(props.query) ?? localQuery();
  const setQuery = (value: string) => {
    setLocalQuery(value);
    props.onQueryChange?.(value);
  };
  const error = () => resolveMaybeAccessor(props.error);
  const [focusedIndex, setFocusedIndex] = createSignal(-1);
  let inputRef: HTMLInputElement | undefined;
  let optionRefs: HTMLButtonElement[] = [];
  const loader = createChoiceLoader(
    () => async (value, signal) => (await props.fetchData(value, signal)).map((option) => ({ ...option, value: option.id })),
    // Cloud debounces at 200ms and then pads the response with a 200ms minimum
    // load time to stop the spinner flickering. The spinner here sits in the
    // chevron slot and stale results stay visible, so there is nothing to pad —
    // 150ms keeps typing responsive without hammering the loader.
    () => props.debounceMs ?? 150,
  );
  const popover = createChoicePopover(() => Boolean(props.disabled || props.readOnly));
  const options = loader.options;
  const focusedOption = () => options()[focusedIndex()];
  const focus = (index: number) => {
    setFocusedIndex(index);
    optionRefs[index]?.scrollIntoView({ block: "nearest" });
  };
  /** `eager` loads the currently controlled query on open; typing supplies its
   *  own query, so opening from `onInput` skips the duplicate request. */
  const open = (eager = true) => {
    if (props.disabled || props.readOnly || popover.open()) return;
    popover.show();
    if (eager) loader.load(query(), true);
    focus(-1);
  };
  const reset = () => {
    loader.cancel();
    setQuery("");
    focus(-1);
  };
  const close = () => {
    popover.hide();
    reset();
  };
  createEffect(() => {
    if (props.readOnly) {
      popover.hide();
      loader.cancel();
      setFocusedIndex(-1);
    }
  });
  const select = (option: ChoiceOption<string>) => {
    if (props.disabled || props.readOnly) return;
    popover.hide();
    props.onSelect({ id: option.value, label: option.label, description: option.description, icon: option.icon });
    reset();
    inputRef?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (props.disabled || props.readOnly) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!popover.open()) open();
      else focus(nextEnabledChoiceIndex(options(), focusedIndex(), event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter" && popover.open()) {
      // While the results are open, Enter belongs to them: it never submits an enclosing form, even with no option active.
      event.preventDefault();
      const option = options()[focusedIndex()];
      if (option) select(option);
    } else if ((event.key === "Escape" || event.key === "Tab") && popover.open()) {
      // Escape is only ours while the list is open; otherwise it has to reach an
      // enclosing dialog or drawer.
      if (event.key === "Escape") event.preventDefault();
      close();
    }
  };

  return (
    <Field
      class={props.class}
      label={props.label}
      description={props.description}
      error={error()}
      meta={meta}
      required={props.required}
      disabled={props.disabled}
    >
      <div class="k2b-combobox" data-invalid={error() ? "true" : undefined}>
        <div ref={popover.setTrigger} class="k2b-combobox__input">
          <i class="ti ti-search" aria-hidden="true" />
          {/* A click, typing, or an arrow key opens the list. Focus alone (Tab, a dialog's initial focus) does not, so Escape still closes the enclosing dialog. */}
          <input
            ref={(element) => {
              inputRef = element;
            }}
            id={meta.controlId}
            type="text"
            value={query()}
            placeholder={props.placeholder ?? messages().search}
            disabled={props.disabled}
            readOnly={props.readOnly}
            aria-readonly={props.readOnly ? "true" : undefined}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={popover.open()}
            aria-controls={listboxId}
            aria-activedescendant={focusedOption() ? `${listboxId}-${focusedIndex()}` : undefined}
            {...fieldControlAria(meta, props)}
            onClick={() => open()}
            onInput={(event) => {
              if (props.disabled || props.readOnly) {
                event.currentTarget.value = query();
                return;
              }
              setQuery(event.currentTarget.value);
              open(false);
              loader.load(event.currentTarget.value);
              focus(-1);
            }}
            onKeyDown={onKeyDown}
          />
          <Show when={loader.loading()} fallback={<i class="ti ti-chevron-down" aria-hidden="true" />}>
            <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
          </Show>
        </div>
        <div ref={popover.setPopover} popover="manual" class="k2b-choice-popover">
          <div class="k2b-choice-options" role="listbox" id={listboxId}>
            <Show when={loader.error()}>
              {(message) => (
                <div class="k2b-choice-status" data-tone="danger">
                  <span>{message()}</span>
                  <button type="button" onClick={loader.retry}>
                    {messages().retry}
                  </button>
                </div>
              )}
            </Show>
            <For
              each={loader.error() ? [] : options()}
              fallback={
                <div class="k2b-choice-status">{query().length >= 2 ? selectMessages().noResultsFound : selectMessages().typeToSearch}</div>
              }
            >
              {(option, index) => (
                <button
                  ref={(element) => (optionRefs[index()] = element)}
                  type="button"
                  id={`${listboxId}-${index()}`}
                  class="k2b-choice-option"
                  role="option"
                  aria-selected={index() === focusedIndex()}
                  data-focused={index() === focusedIndex() ? "true" : undefined}
                  onPointerMove={() => focus(index())}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => select(option)}
                >
                  <Show when={option.icon}>{(icon) => <i class={iconClass(icon())} aria-hidden="true" />}</Show>
                  <span>
                    <strong>{option.label}</strong>
                    <Show when={option.description}>{(description) => <small>{description()}</small>}</Show>
                  </span>
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </Field>
  );
}

export default Combobox;
