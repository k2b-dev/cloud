import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { colorTintStyle, normalizeHexColor } from "../internal/color";
import { createFieldMeta, Field, fieldControlAria } from "../internal/field";
import { type ChoiceOption, createChoiceLoader, createChoicePopover, filterChoiceOptions, nextEnabledChoiceIndex } from "./choice";
import type { ValueFieldProps } from "./field-contract";
import { commitFieldValue, resolveMaybeAccessor } from "./field-contract";
import type { SelectGroup } from "./Select";

export type MultiSelectOption =
  | string
  | { id: string; label?: string; description?: string; icon?: string; color?: string; groups?: readonly string[] }
  | ChoiceOption<string>;
type NormalizedOption = ChoiceOption<string>;
export type MultiSelectFetchDataFn = (query: string, signal: AbortSignal, group: string | null) => Promise<MultiSelectOption[]>;

export type MultiSelectInputProps = ValueFieldProps<string[]> & {
  options?: MultiSelectOption[];
  fetchData?: MultiSelectFetchDataFn;
  selectedOptions?: () => MultiSelectOption[];
  placeholder?: string;
  icon?: string;
  activeIcon?: string;
  fetchDebounceMs?: number;
  debounceMs?: number;
  loadOptions?: (query: string, signal: AbortSignal, group: string | null) => Promise<readonly ChoiceOption<string>[]>;
  groups?: readonly SelectGroup[];
  defaultGroup?: string;
  groupsAriaLabel?: string;
  allGroupLabel?: string;
  searchable?: boolean;
  clearable?: boolean;
  name?: string;
  renderOption?: (option: ChoiceOption<string>) => JSX.Element;
  renderValue?: (option: ChoiceOption<string>) => JSX.Element;
  searchPlaceholder?: string;
  loadingLabel?: string;
  noResultsLabel?: string;
  emptyLabel?: string;
  retryLabel?: string;
  clearLabel?: string;
};

/** Cloud tints the option icon with the option color instead of adding a dot. */
const iconColor = (color: string | undefined): JSX.CSSProperties | undefined => {
  const normalized = normalizeHexColor(color);
  return normalized ? { color: normalized } : undefined;
};

const normalize = (option: MultiSelectOption): NormalizedOption =>
  typeof option === "string"
    ? { value: option, label: option }
    : "value" in option
      ? option
      : { ...option, value: option.id, label: option.label || option.id };

export function MultiSelectInput(props: MultiSelectInputProps): JSX.Element {
  const meta = createFieldMeta(props.id);
  const listboxId = `${meta.controlId}-listbox`;
  const [query, setQuery] = createSignal("");
  const [focusedIndex, setFocusedIndex] = createSignal(-1);
  const [cache, setCache] = createSignal<Record<string, NormalizedOption>>({});
  const [selectedGroup, setSelectedGroup] = createSignal<string | null>(props.defaultGroup ?? null);
  let searchRef: HTMLInputElement | undefined;
  let groupRefs: HTMLButtonElement[] = [];

  const values = () => resolveMaybeAccessor(props.value) ?? [];
  const error = () => resolveMaybeAccessor(props.error);
  const activeGroup = createMemo(() => {
    const current = selectedGroup();
    return current && props.groups?.some((group) => group.value === current) ? current : null;
  });
  const groupChoices = createMemo(() => [{ value: null, label: props.allGroupLabel ?? "All" }, ...(props.groups ?? [])]);
  const asyncOptions = createChoiceLoader(
    () =>
      props.fetchData
        ? async (query, signal) => (await props.fetchData!(query, signal, activeGroup())).map(normalize)
        : props.loadOptions
          ? (query, signal) => props.loadOptions!(query, signal, activeGroup())
          : undefined,
    () => props.fetchDebounceMs ?? props.debounceMs ?? 200,
  );
  const isAsync = () => Boolean(props.fetchData || props.loadOptions);
  const sourceOptions = createMemo(() => (isAsync() ? asyncOptions.options() : (props.options ?? []).map(normalize)));
  const groupedOptions = createMemo(() => {
    const group = activeGroup();
    return !isAsync() && group ? sourceOptions().filter((option) => option.groups?.includes(group)) : sourceOptions();
  });
  // Cloud's multi-select always renders its search field, and filters a static
  // option list client-side while a remote loader filters server-side.
  const searchable = () => isAsync() || (props.searchable ?? true);
  const visibleOptions = createMemo(() =>
    isAsync() ? groupedOptions() : filterChoiceOptions(groupedOptions(), searchable() ? query() : ""),
  );
  const optionByValue = createMemo(() => {
    const options = new Map<string, NormalizedOption>();
    for (const option of Object.values(cache())) options.set(option.value, option);
    for (const option of (props.selectedOptions?.() ?? []).map(normalize)) options.set(option.value, option);
    for (const option of sourceOptions()) options.set(option.value, option);
    return options;
  });
  const selected = createMemo(() => values().map((value) => optionByValue().get(value) ?? ({ value, label: value } as NormalizedOption)));
  const hasClearAction = () => Boolean(props.clearable && selected().length > 0 && !props.disabled);
  const selectedValues = createMemo(() => new Set(values()));
  const popover = createChoicePopover(() => Boolean(props.disabled));
  const focusedOption = () => visibleOptions()[focusedIndex()];

  const emit = (next: readonly string[]) => {
    const unique = [...new Set(next)];
    commitFieldValue(props, unique);
  };
  const isSelected = (value: string) => selectedValues().has(value);
  const focusFirst = () => setFocusedIndex(nextEnabledChoiceIndex(visibleOptions(), -1, 1));
  const chooseGroup = (group: string | null) => {
    if (group === activeGroup()) return;
    setSelectedGroup(group);
    focusFirst();
    if (isAsync()) asyncOptions.load(query(), true);
  };
  const moveGroupFocus = (index: number, direction: 1 | -1) => {
    const choices = groupChoices();
    const next = (index + direction + choices.length) % choices.length;
    chooseGroup(choices[next]?.value ?? null);
    queueMicrotask(() => groupRefs[next]?.focus());
  };
  const focusGroupEdge = (last: boolean) => {
    const index = last ? groupChoices().length - 1 : 0;
    chooseGroup(groupChoices()[index]?.value ?? null);
    queueMicrotask(() => groupRefs[index]?.focus());
  };
  const open = () => {
    if (props.disabled) return;
    setQuery("");
    if (isAsync()) asyncOptions.load("", true);
    focusFirst();
    popover.show();
    if (searchable()) queueMicrotask(() => searchRef?.focus());
  };
  const close = (restoreFocus = false) => {
    asyncOptions.cancel();
    setQuery("");
    setFocusedIndex(-1);
    popover.hide(restoreFocus);
  };
  const toggleOption = (option: NormalizedOption) => {
    if (option.disabled) return;
    setCache({ ...cache(), [option.value]: option });
    emit(isSelected(option.value) ? values().filter((value) => value !== option.value) : [...values(), option.value]);
  };
  const remove = (value: string) => emit(values().filter((item) => item !== value));
  const move = (direction: 1 | -1) => {
    setFocusedIndex(nextEnabledChoiceIndex(visibleOptions(), focusedIndex(), direction));
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    const inToolbar = Boolean((event.target as HTMLElement | null)?.closest?.(".k2b-choice-toolbar"));
    if (inToolbar && event.key !== "Escape" && event.key !== "Tab") return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!popover.open()) open();
      else move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && !popover.open()) {
      event.preventDefault();
      open();
      return;
    }
    if (event.key === "Enter" && popover.open()) {
      const option = focusedOption();
      if (option) {
        event.preventDefault();
        toggleOption(option);
      }
      return;
    }
    if (event.key === "Backspace" && popover.open() && !query() && values().length > 0) {
      event.preventDefault();
      const last = values().at(-1);
      if (last) remove(last);
      return;
    }
    if (event.key === "Escape" && popover.open()) {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab" && popover.open()) {
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
      labelFor={false}
      required={props.required}
      disabled={props.disabled}
    >
      <div class="k2b-choice-control" data-invalid={error() ? "true" : undefined}>
        <div
          ref={popover.setTrigger}
          id={meta.controlId}
          class="k2b-multi-select-trigger"
          role="combobox"
          tabIndex={props.disabled ? -1 : 0}
          aria-haspopup="listbox"
          aria-expanded={popover.open()}
          aria-controls={listboxId}
          aria-activedescendant={focusedOption() ? `${listboxId}-${focusedIndex()}` : undefined}
          {...fieldControlAria(meta, props)}
          aria-disabled={props.disabled}
          data-disabled={props.disabled ? "true" : undefined}
          onClick={() => (popover.open() ? close() : open())}
          onKeyDown={handleKeyDown}
        >
          <Show
            when={selected().length > 0}
            fallback={
              <span class="k2b-choice-trigger__value" data-placeholder="true">
                {props.placeholder ?? "Select..."}
              </span>
            }
          >
            <span class="k2b-multi-select-trigger__values">
              <For each={selected()}>
                {(option) => (
                  <span class="k2b-choice-pill" style={colorTintStyle(option.color)}>
                    <Show
                      when={props.renderValue}
                      fallback={
                        <>
                          <Show when={option.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
                          <span>{option.label}</span>
                        </>
                      }
                    >
                      {(render) => <span class="k2b-choice-pill__content">{render()(option)}</span>}
                    </Show>
                    <button
                      type="button"
                      aria-label={`Remove ${option.label}`}
                      disabled={props.disabled}
                      tabIndex={-1}
                      onClick={(event) => {
                        event.stopPropagation();
                        remove(option.value);
                      }}
                    >
                      <i class="ti ti-x" aria-hidden="true" />
                    </button>
                  </span>
                )}
              </For>
            </span>
          </Show>
          <Show when={!hasClearAction()}>
            <i
              class={`${popover.open() ? (props.activeIcon ?? "ti ti-chevron-up") : (props.icon ?? "ti ti-chevron-down")} k2b-multi-select-trigger__chevron`}
              aria-hidden="true"
            />
          </Show>
        </div>
        <Show when={hasClearAction()}>
          <button
            type="button"
            class="k2b-choice-control__clear k2b-input-clear-action"
            aria-label={props.clearLabel ?? "Clear selection"}
            onClick={(event) => {
              event.stopPropagation();
              emit([]);
              popover.trigger()?.focus();
            }}
          >
            <i class="ti ti-x" aria-hidden="true" />
          </button>
        </Show>

        <div
          ref={popover.setPopover}
          popover="manual"
          class="k2b-choice-popover"
          role="group"
          onKeyDown={handleKeyDown}
          aria-label={typeof props.label === "string" ? props.label : "Options"}
        >
          <Show when={searchable()}>
            <div class="k2b-choice-search">
              <i class="ti ti-search" aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                value={query()}
                placeholder={props.searchPlaceholder ?? "Search..."}
                aria-label={props.searchPlaceholder ?? "Search options"}
                aria-controls={listboxId}
                aria-activedescendant={focusedOption() ? `${listboxId}-${focusedIndex()}` : undefined}
                onInput={(event) => {
                  const next = event.currentTarget.value;
                  setQuery(next);
                  if (isAsync()) asyncOptions.load(next);
                  focusFirst();
                }}
              />
            </div>
          </Show>
          <Show when={(props.groups?.length ?? 0) > 0}>
            <div class="k2b-choice-toolbar">
              <div class="k2b-choice-groups" role="radiogroup" aria-label={props.groupsAriaLabel ?? "Filter options"}>
                <For each={groupChoices()}>
                  {(group, index) => (
                    <button
                      ref={(element) => (groupRefs[index()] = element)}
                      type="button"
                      role="radio"
                      aria-checked={activeGroup() === group.value}
                      aria-controls={listboxId}
                      tabIndex={activeGroup() === group.value ? 0 : -1}
                      onClick={() => chooseGroup(group.value)}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                          event.preventDefault();
                          moveGroupFocus(index(), 1);
                        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                          event.preventDefault();
                          moveGroupFocus(index(), -1);
                        } else if (event.key === "Home" || event.key === "End") {
                          event.preventDefault();
                          focusGroupEdge(event.key === "End");
                        }
                      }}
                    >
                      {group.label}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <div id={listboxId} class="k2b-choice-options" role="listbox" aria-multiselectable="true">
            <Show when={asyncOptions.error()}>
              {(message) => (
                <div class="k2b-choice-status" data-tone="danger">
                  <span>{message()}</span>
                  <button type="button" onClick={asyncOptions.retry}>
                    {props.retryLabel ?? "Retry"}
                  </button>
                </div>
              )}
            </Show>
            <Show when={asyncOptions.loading() && visibleOptions().length === 0}>
              <div class="k2b-choice-status">
                <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
                <span>{props.loadingLabel ?? "Loading..."}</span>
              </div>
            </Show>
            <For
              each={asyncOptions.error() ? [] : visibleOptions()}
              fallback={
                <Show when={!asyncOptions.loading() && !asyncOptions.error()}>
                  <div class="k2b-choice-status">
                    {isAsync() || query() ? (props.noResultsLabel ?? "No results") : (props.emptyLabel ?? "No options available")}
                  </div>
                </Show>
              }
            >
              {(option, index) => (
                <button
                  type="button"
                  id={`${listboxId}-${index()}`}
                  class="k2b-choice-option"
                  role="option"
                  aria-label={option.label}
                  aria-selected={isSelected(option.value)}
                  data-focused={index() === focusedIndex() ? "true" : undefined}
                  disabled={option.disabled}
                  onPointerMove={() => !option.disabled && setFocusedIndex(index())}
                  onClick={() => toggleOption(option)}
                >
                  <span class="k2b-choice-option__checkbox" aria-hidden="true">
                    <i class="ti ti-check" />
                  </span>
                  <Show
                    when={option.icon}
                    fallback={
                      <Show when={normalizeHexColor(option.color)}>
                        {(color) => <span class="k2b-choice-dot" style={{ background: color() }} aria-hidden="true" />}
                      </Show>
                    }
                  >
                    {(icon) => <i class={icon()} style={iconColor(option.color)} aria-hidden="true" />}
                  </Show>
                  <span class="k2b-choice-option__content">
                    <Show
                      when={props.renderOption}
                      fallback={
                        <>
                          <strong>{option.label}</strong>
                          <Show when={option.description}>{(description) => <small>{description()}</small>}</Show>
                        </>
                      }
                    >
                      {(render) => render()(option)}
                    </Show>
                  </span>
                </button>
              )}
            </For>
          </div>
        </div>
        <Show when={props.name}>{(name) => <input type="hidden" name={name()} value={values().join(",")} />}</Show>
      </div>
    </Field>
  );
}

export default MultiSelectInput;
