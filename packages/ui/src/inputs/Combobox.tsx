import { createEffect, createSignal, For, type JSX, on, Show } from "solid-js";
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
  /** The query is the field's own value: picking or closing keeps the typed text, and Enter without an active option only closes the list. */
  freeText?: boolean;
  /** Below this many characters nothing loads and the list stays closed. */
  minQueryLength?: number;
  /** This result (by position) is active as soon as results arrive, so Enter takes it. */
  autoHighlight?: number;
  /** Replaces the results with a host-owned notice, such as an exhausted quota; nothing loads while it is set. */
  status?: JSX.Element;
  /** Shown instead of the default text when a search finds nothing. */
  empty?: JSX.Element;
  /** One line under the results, such as their source. */
  footer?: JSX.Element;
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
  const searchable = (value: string) => value.trim().length >= (props.minQueryLength ?? 0);
  const focus = (index: number) => {
    setFocusedIndex(index);
    optionRefs[index]?.scrollIntoView({ block: "nearest" });
  };
  /** `eager` loads the currently controlled query on open; typing supplies its
   *  own query, so opening from `onInput` skips the duplicate request. */
  const open = (eager = true) => {
    if (props.disabled || props.readOnly || popover.open() || !searchable(query())) return;
    popover.show();
    if (eager && !props.status) loader.load(query(), true);
    focus(-1);
  };
  const reset = () => {
    loader.cancel();
    setQuery("");
    focus(-1);
  };
  const close = () => {
    popover.hide();
    if (!props.freeText) return reset();
    loader.cancel();
    focus(-1);
  };
  createEffect(
    on(options, (list) => {
      const index = props.autoHighlight;
      if (index !== undefined && focusedIndex() < 0 && popover.open() && list.length > 0) setFocusedIndex(Math.min(index, list.length - 1));
    }),
  );
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
    if (props.freeText) {
      loader.cancel();
      focus(-1);
    } else reset();
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
      else if (props.freeText) close();
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
            autocomplete="off"
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
              const value = event.currentTarget.value;
              setQuery(value);
              focus(-1);
              if (!searchable(value)) {
                popover.hide();
                loader.cancel();
                return;
              }
              open(false);
              if (!props.status) loader.load(value);
            }}
            onKeyDown={onKeyDown}
          />
          <Show when={loader.loading()} fallback={<i class="ti ti-chevron-down" aria-hidden="true" />}>
            <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
          </Show>
        </div>
        <div ref={popover.setPopover} popover="manual" class="k2b-choice-popover">
          <div class="k2b-choice-options" role="listbox" id={listboxId}>
            <Show when={props.status}>{(status) => <div class="k2b-choice-status">{status()}</div>}</Show>
            <Show when={!props.status && loader.error()}>
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
              each={props.status || loader.error() ? [] : options()}
              fallback={
                <Show when={!props.status && !loader.error()}>
                  <Show
                    when={loader.loading()}
                    fallback={
                      <div class="k2b-choice-status">
                        {query().length >= 2 ? (props.empty ?? selectMessages().noResultsFound) : selectMessages().typeToSearch}
                      </div>
                    }
                  >
                    {/* The first search has nothing to keep visible yet: rows of the final size wait in its place. */}
                    <div class="k2b-choice-loading" role="status">
                      <span class="k2b-sr-only">{messages().loading}</span>
                      <For each={[62, 48, 55]}>
                        {(width) => (
                          <div class="k2b-choice-loading__row" aria-hidden="true">
                            <span class="k2b-skeleton" />
                            <span class="k2b-skeleton" style={{ width: `${width}%` }} />
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
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
          <Show when={props.footer}>{(footer) => <div class="k2b-choice-footer">{footer()}</div>}</Show>
        </div>
      </div>
    </Field>
  );
}

export default Combobox;
