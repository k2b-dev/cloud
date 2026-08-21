import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { createFieldMeta, Field, fieldControlAria } from "../internal/field";
import { ChoiceGroups } from "./ChoiceGroups";
import { type ChoiceOption, createChoiceLoader, createChoicePopover, nextEnabledChoiceIndex } from "./choice";
import type { ValueFieldProps } from "./field-contract";
import { commitFieldValue, resolveMaybeAccessor } from "./field-contract";
import type { SelectGroup } from "./Select";

export type AutocompleteSelectOption = ChoiceOption<string>;

export type AutocompleteSelectSearchResult = {
  /** Ranked suggestions shown in the popup. */
  options: readonly AutocompleteSelectOption[];
  /** The authoritative option that Tab or blur may accept automatically. */
  match?: AutocompleteSelectOption;
};

export type AutocompleteSelectProps = ValueFieldProps<string | null> & {
  search: (query: string, signal: AbortSignal, group: string | null) => Promise<AutocompleteSelectSearchResult>;
  selectedOption?: AutocompleteSelectOption;
  formatValue?: (option: AutocompleteSelectOption) => string;
  groups?: readonly SelectGroup[];
  defaultGroup?: string;
  groupsAriaLabel?: string;
  allGroupLabel?: string;
  placeholder?: string;
  debounceMs?: number;
  clearable?: boolean;
  name?: string;
  autofocus?: boolean;
  noMatchText?: string;
  checkingText?: string;
  noOptionsText?: string;
};

type SelectionSnapshot = {
  value: string | null;
  option?: AutocompleteSelectOption;
  display: string;
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : "Options could not be loaded");

export function AutocompleteSelect(props: AutocompleteSelectProps): JSX.Element {
  const meta = createFieldMeta(props.id);
  const listboxId = `${meta.controlId}-listbox`;
  const [cache, setCache] = createSignal<Record<string, AutocompleteSelectOption>>({});
  const value = () => resolveMaybeAccessor(props.value) ?? null;
  const selected = createMemo<AutocompleteSelectOption | undefined>(() => {
    const current = value();
    if (current === null) return undefined;
    return (
      cache()[current] ??
      (props.selectedOption?.value === current ? props.selectedOption : undefined) ?? {
        value: current,
        label: current,
      }
    );
  });
  const formatValue = (option: AutocompleteSelectOption | undefined): string =>
    option ? (props.formatValue?.(option) ?? option.label) : "";

  const [display, setDisplay] = createSignal(formatValue(selected()));
  const [query, setQuery] = createSignal("");
  const [focused, setFocused] = createSignal(false);
  const [editing, setEditing] = createSignal(false);
  const [resolvedQuery, setResolvedQuery] = createSignal<string>();
  const [match, setMatch] = createSignal<AutocompleteSelectOption>();
  const [focusedIndex, setFocusedIndex] = createSignal(-1);
  const [selectedGroup, setSelectedGroup] = createSignal<string | null>(props.defaultGroup ?? null);
  const [explicitOption, setExplicitOption] = createSignal(false);
  const [internalError, setInternalError] = createSignal<string>();
  const externalError = () => resolveMaybeAccessor(props.error);
  const error = () => externalError() ?? internalError();
  const hasClearAction = () => Boolean(props.clearable && value() !== null && !props.disabled);
  let inputRef: HTMLInputElement | undefined;
  let popoverRef: HTMLDivElement | undefined;
  let optionRefs: HTMLButtonElement[] = [];
  let pointerFocus = false;
  let pendingCommitQuery: string | undefined;
  let snapshot: SelectionSnapshot = { value: value(), option: selected(), display: formatValue(selected()) };

  const popover = createChoicePopover(() => Boolean(props.disabled));
  const activeGroup = createMemo(() => {
    const current = selectedGroup();
    return current && props.groups?.some((group) => group.value === current) ? current : null;
  });
  const groupChoices = createMemo(() => [{ value: null, label: props.allGroupLabel ?? "All" }, ...(props.groups ?? [])]);

  const remember = (options: readonly AutocompleteSelectOption[], authoritative?: AutocompleteSelectOption) => {
    const next = { ...cache() };
    for (const option of options) next[option.value] = option;
    if (authoritative) next[authoritative.value] = authoritative;
    setCache(next);
  };

  const completeInput = (typed: string, authoritative: AutocompleteSelectOption | undefined) => {
    if (!inputRef || !focused() || !editing() || !authoritative || typed.length === 0) return;
    const lower = typed.toLocaleLowerCase();
    const completion = [authoritative.value, authoritative.label].find((candidate) => candidate.toLocaleLowerCase().startsWith(lower));
    if (!completion || completion.length <= typed.length) return;
    setDisplay(completion);
    queueMicrotask(() => {
      if (!inputRef || document.activeElement !== inputRef || query() !== typed) return;
      inputRef.setSelectionRange(typed.length, completion.length);
    });
  };

  const mergedOptions = (result: AutocompleteSelectSearchResult): readonly AutocompleteSelectOption[] =>
    result.match && !result.options.some((option) => option.value === result.match!.value)
      ? [result.match, ...result.options]
      : result.options;

  const commit = (option: AutocompleteSelectOption) => {
    if (option.disabled) return;
    pendingCommitQuery = undefined;
    loader.cancel();
    popover.hide();
    remember([], option);
    setDisplay(formatValue(option));
    setQuery("");
    setResolvedQuery(undefined);
    setMatch(undefined);
    setFocusedIndex(-1);
    setExplicitOption(false);
    setInternalError(undefined);
    snapshot = { value: option.value, option, display: formatValue(option) };
    commitFieldValue(props, option.value);
    setEditing(false);
  };

  const invalidate = (message = props.noMatchText ?? "No matching option found") => {
    pendingCommitQuery = undefined;
    setInternalError(message);
    popover.hide();
  };

  const loader = createChoiceLoader(
    () => async (typed, signal) => {
      let result: AutocompleteSelectSearchResult;
      try {
        result = await props.search(typed, signal, activeGroup());
      } catch (reason) {
        if (!signal.aborted) {
          setResolvedQuery(typed);
          if (pendingCommitQuery === typed) invalidate(errorMessage(reason));
        }
        throw reason;
      }
      if (signal.aborted) return [];

      const options = mergedOptions(result);
      const authoritative = result.match?.disabled ? undefined : result.match;
      remember(options, authoritative);
      setResolvedQuery(typed);
      setMatch(authoritative);
      setExplicitOption(false);
      setFocusedIndex(authoritative ? options.findIndex((option) => option.value === authoritative.value) : -1);
      completeInput(typed, authoritative);

      if (pendingCommitQuery === typed) {
        if (authoritative) commit(authoritative);
        else invalidate();
      }
      return options;
    },
    () => props.debounceMs ?? 150,
  );

  const options = () => (resolvedQuery() === query() ? loader.options() : []);
  const loadError = () => (resolvedQuery() === query() ? loader.error() : undefined);
  const focusedOption = () => options()[focusedIndex()];
  const focusOption = (index: number, explicit = true) => {
    setFocusedIndex(index);
    setExplicitOption(explicit);
    optionRefs[index]?.scrollIntoView({ block: "nearest" });
  };
  const move = (direction: 1 | -1) => focusOption(nextEnabledChoiceIndex(options(), focusedIndex(), direction));

  const startSearch = (typed: string, immediate = false) => {
    setInternalError(undefined);
    setResolvedQuery(undefined);
    setMatch(undefined);
    setFocusedIndex(-1);
    setExplicitOption(false);
    popover.show();
    loader.load(typed, immediate);
  };

  const chooseGroup = (group: string | null) => {
    if (group === activeGroup()) return;
    setSelectedGroup(group);
    startSearch(editing() ? query() : "", true);
  };

  const selectedForCommit = (): AutocompleteSelectOption | undefined => {
    if (resolvedQuery() !== query()) return undefined;
    if (explicitOption()) return focusedOption();
    return match();
  };

  const requestCommit = () => {
    if (!editing()) return;
    const option = selectedForCommit();
    if (option) {
      commit(option);
      return;
    }
    if (query() === "" && props.clearable && !props.required) {
      pendingCommitQuery = undefined;
      loader.cancel();
      popover.hide();
      snapshot = { value: null, option: undefined, display: "" };
      setDisplay("");
      setQuery("");
      setEditing(false);
      setResolvedQuery(undefined);
      setMatch(undefined);
      setFocusedIndex(-1);
      setExplicitOption(false);
      setInternalError(undefined);
      commitFieldValue(props, null);
      return;
    }
    if (pendingCommitQuery === query()) return;
    pendingCommitQuery = query();
    if (resolvedQuery() === query() && !loader.loading()) invalidate();
    else loader.load(query(), true);
  };

  const restore = () => {
    const target = snapshot;
    pendingCommitQuery = undefined;
    loader.cancel();
    popover.hide();
    remember(target.option ? [target.option] : []);
    setDisplay(target.display);
    setQuery("");
    setResolvedQuery(undefined);
    setMatch(undefined);
    setFocusedIndex(-1);
    setExplicitOption(false);
    setInternalError(undefined);
    if (value() !== target.value) props.onValueChange?.(target.value);
    setEditing(false);
    queueMicrotask(() => inputRef?.select());
  };

  createEffect(() => {
    if (editing()) return;
    const option = selected();
    setDisplay(formatValue(option));
    snapshot = { value: value(), option, display: formatValue(option) };
  });

  createEffect(() => {
    if (!inputRef) return;
    const message = internalError();
    inputRef.setCustomValidity(message ?? (editing() ? "Select a matching option" : ""));
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!popover.open()) {
        const typed = editing() ? query() : "";
        startSearch(typed, true);
      } else {
        move(event.key === "ArrowDown" ? 1 : -1);
      }
    } else if (event.key === "Enter" && popover.open()) {
      const option = selectedForCommit();
      if (!option) return;
      event.preventDefault();
      commit(option);
      inputRef?.select();
    } else if (event.key === "Escape" && (editing() || popover.open())) {
      event.preventDefault();
      if (editing()) restore();
      else popover.hide();
    } else if (event.key === "Tab") {
      requestCommit();
      popover.hide();
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
        <div ref={popover.setTrigger} class="k2b-combobox__input" data-clearable={hasClearAction() ? "true" : undefined}>
          <i class="ti ti-search" aria-hidden="true" />
          <input
            ref={(element) => {
              inputRef = element;
            }}
            id={meta.controlId}
            type="text"
            value={display()}
            placeholder={props.placeholder ?? "Type to search..."}
            disabled={props.disabled}
            required={props.required}
            autofocus={props.autofocus}
            autocomplete="off"
            spellcheck={false}
            role="combobox"
            aria-autocomplete="both"
            aria-expanded={popover.open()}
            aria-controls={listboxId}
            aria-activedescendant={focusedOption() ? `${listboxId}-${focusedIndex()}` : undefined}
            {...fieldControlAria(meta, { ...props, error: error() })}
            onPointerDown={() => {
              pointerFocus = true;
              queueMicrotask(() => (pointerFocus = false));
            }}
            onFocus={() => {
              setFocused(true);
              if (!editing()) {
                const option = selected();
                snapshot = { value: value(), option, display: formatValue(option) };
                setDisplay(snapshot.display);
              }
              if (!pointerFocus) queueMicrotask(() => inputRef?.select());
            }}
            onClick={() => {
              if (!editing()) startSearch("", true);
            }}
            onInput={(event) => {
              const typed = event.currentTarget.value;
              const beginsEdit = !editing();
              setEditing(true);
              if (beginsEdit && value() !== null) props.onValueChange?.(null);
              setDisplay(typed);
              setQuery(typed);
              pendingCommitQuery = undefined;
              startSearch(typed);
            }}
            onKeyDown={onKeyDown}
            onBlur={(event) => {
              setFocused(false);
              if (event.relatedTarget instanceof Node && popoverRef?.contains(event.relatedTarget)) return;
              requestCommit();
              popover.hide();
            }}
          />
          <Show when={hasClearAction()}>
            <button
              type="button"
              class="k2b-choice-control__clear k2b-input-clear-action"
              tabindex={-1}
              aria-label="Clear selection"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                snapshot = { value: null, option: undefined, display: "" };
                setDisplay("");
                setQuery("");
                setEditing(false);
                setResolvedQuery(undefined);
                setMatch(undefined);
                setFocusedIndex(-1);
                setExplicitOption(false);
                setInternalError(undefined);
                commitFieldValue(props, null);
                inputRef?.focus();
              }}
            >
              <i class="ti ti-x" aria-hidden="true" />
            </button>
          </Show>
          <Show
            when={loader.loading()}
            fallback={
              <Show when={editing() && match()} fallback={<i class="ti ti-chevron-down" aria-hidden="true" />}>
                <i class="ti ti-check" aria-hidden="true" />
              </Show>
            }
          >
            <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
          </Show>
        </div>
        <Show when={props.name}>{(name) => <input type="hidden" name={name()} value={value() ?? ""} />}</Show>
        <span class="k2b-sr-only" role="status" aria-live="polite" aria-atomic="true">
          {loader.loading()
            ? (props.checkingText ?? "Checking options")
            : match()
              ? `Match: ${formatValue(match())}`
              : (internalError() ?? "")}
        </span>
        <div
          ref={(element) => {
            popoverRef = element;
            popover.setPopover(element);
          }}
          popover="manual"
          class="k2b-choice-popover"
          role="group"
          aria-label={typeof props.label === "string" ? props.label : "Options"}
          onFocusOut={(event) => {
            if (event.relatedTarget instanceof Node && (popoverRef?.contains(event.relatedTarget) || inputRef === event.relatedTarget))
              return;
            requestCommit();
            popover.hide();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            if (editing()) restore();
            else {
              popover.hide();
              inputRef?.focus();
            }
          }}
        >
          <Show when={(props.groups?.length ?? 0) > 0}>
            <div class="k2b-choice-toolbar">
              <ChoiceGroups
                choices={groupChoices()}
                value={activeGroup()}
                onValueChange={chooseGroup}
                ariaLabel={props.groupsAriaLabel ?? "Filter options"}
                controls={listboxId}
              />
            </div>
          </Show>
          <div id={listboxId} class="k2b-choice-options" role="listbox">
            <Show when={loadError()}>
              {(message) => (
                <div class="k2b-choice-status" data-tone="danger">
                  <span>{message()}</span>
                  <button
                    type="button"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setInternalError(undefined);
                      loader.retry();
                    }}
                  >
                    Retry
                  </button>
                </div>
              )}
            </Show>
            <Show when={loader.loading() && options().length === 0}>
              <div class="k2b-choice-status">
                <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
                <span>{props.checkingText ?? "Checking options..."}</span>
              </div>
            </Show>
            <For
              each={loadError() ? [] : options()}
              fallback={
                <Show when={!loader.loading() && !loadError()}>
                  <div class="k2b-choice-status">{props.noOptionsText ?? "No options found"}</div>
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
                  aria-label={option.label}
                  aria-selected={index() === focusedIndex()}
                  data-focused={index() === focusedIndex() ? "true" : undefined}
                  disabled={option.disabled}
                  onPointerMove={() => focusOption(index())}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    commit(option);
                    inputRef?.focus();
                    inputRef?.select();
                  }}
                >
                  <Show when={option.color} fallback={<Show when={option.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>}>
                    {(color) => <span class="k2b-choice-dot" style={{ "background-color": color() }} aria-hidden="true" />}
                  </Show>
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

export default AutocompleteSelect;
