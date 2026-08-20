import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { createFieldMeta, Field, fieldControlAria } from "../internal/field";
import { type ChoiceOption, createChoiceLoader, createChoicePopover, filterChoiceOptions, nextEnabledChoiceIndex } from "./choice";
import type { ValueFieldProps } from "./field-contract";
import { commitFieldValue, resolveMaybeAccessor } from "./field-contract";

export type SelectOption = ChoiceOption<string>;
export type SelectGroup = {
  value: string;
  label: string;
};
export type SelectView = "list" | "grid";
export type SelectGridSize = "sm" | "md" | "lg";
export type SelectSourceOption =
  | string
  | {
      id: string;
      label?: string;
      description?: string;
      icon?: string;
      color?: string;
      groups?: readonly string[];
    }
  | SelectOption;

export type SelectProps = ValueFieldProps<string | null> & {
  placeholder?: string;
  icon?: string;
  activeIcon?: string;
  options?: SelectSourceOption[];
  fetchData?: (query: string, signal: AbortSignal, group: string | null) => Promise<SelectSourceOption[]>;
  loadOptions?: (query: string, signal: AbortSignal, group: string | null) => Promise<readonly ChoiceOption<string>[]>;
  selectedOption?: ChoiceOption<string>;
  selectedLabel?: () => string | undefined;
  fetchDebounceMs?: number;
  debounceMs?: number;
  searchable?: boolean;
  /** Optional synchronous filter for static options. */
  filterOptions?: (options: readonly SelectOption[], query: string) => readonly SelectOption[];
  /** Optional filters. An option may belong to more than one group. */
  groups?: readonly SelectGroup[];
  /** Group selected when the component is created. Omit to start with all options. */
  defaultGroup?: string;
  groupsAriaLabel?: string;
  allGroupLabel?: string;
  /** Show a local list/grid layout toggle in the dropdown. */
  viewToggle?: boolean;
  /** Initial dropdown layout when `viewToggle` is enabled. */
  defaultView?: SelectView;
  /** Tile density for the grid layout. */
  gridSize?: SelectGridSize;
  searchPlaceholder?: string;
  clearable?: boolean;
  name?: string;
};

type NormalizedOption = ChoiceOption<string>;
const normalize = (option: SelectSourceOption): NormalizedOption =>
  typeof option === "string"
    ? { value: option, label: option }
    : "value" in option
      ? option
      : { ...option, value: option.id, label: option.label || option.id };

export function Select(props: SelectProps): JSX.Element {
  const meta = createFieldMeta(props.id);
  const listboxId = `${meta.controlId}-listbox`;
  const [query, setQuery] = createSignal("");
  const [focusedIndex, setFocusedIndex] = createSignal(-1);
  const [cache, setCache] = createSignal<Record<string, NormalizedOption>>({});
  const [selectedGroup, setSelectedGroup] = createSignal<string | null>(props.defaultGroup ?? null);
  const [selectedView, setSelectedView] = createSignal<SelectView>(props.defaultView ?? "list");
  let searchRef: HTMLInputElement | undefined;
  let optionRefs: HTMLButtonElement[] = [];
  let groupRefs: HTMLButtonElement[] = [];
  const value = () => resolveMaybeAccessor(props.value) ?? null;
  const error = () => resolveMaybeAccessor(props.error);
  const activeGroup = createMemo(() => {
    const current = selectedGroup();
    return current && props.groups?.some((group) => group.value === current) ? current : null;
  });
  const groupChoices = createMemo(() => [{ value: null, label: props.allGroupLabel ?? "All" }, ...(props.groups ?? [])]);
  const activeView = () => (props.viewToggle ? selectedView() : "list");

  const loader = createChoiceLoader(
    () =>
      props.fetchData
        ? async (value, signal) => (await props.fetchData!(value, signal, activeGroup())).map(normalize)
        : props.loadOptions
          ? (value, signal) => props.loadOptions!(value, signal, activeGroup())
          : undefined,
    () => props.fetchDebounceMs ?? props.debounceMs ?? 200,
  );
  const isAsync = () => Boolean(props.fetchData || props.loadOptions);
  const isSearchable = () => isAsync() || Boolean(props.searchable);
  const sourceOptions = createMemo(() => (isAsync() ? loader.options() : (props.options ?? []).map(normalize)));
  const groupedOptions = createMemo(() => {
    const group = activeGroup();
    return !isAsync() && group ? sourceOptions().filter((option) => option.groups?.includes(group)) : sourceOptions();
  });
  // Remote loaders filter server-side; a static list has to be filtered here or
  // the search field would render but do nothing.
  const options = createMemo(() =>
    isAsync() || !props.searchable
      ? groupedOptions()
      : props.filterOptions
        ? [...props.filterOptions(groupedOptions(), query())]
        : filterChoiceOptions(groupedOptions(), query()),
  );
  const selected = createMemo(() => {
    const current = value();
    if (current === null) return undefined;
    // Resolve against the unfiltered list so typing in the search field never
    // blanks the trigger label of the current selection.
    return (
      sourceOptions().find((option) => option.value === current) ??
      cache()[current] ??
      (props.selectedOption?.value === current ? props.selectedOption : undefined) ?? {
        value: current,
        label: props.selectedLabel?.() ?? current,
      }
    );
  });
  const hasClearAction = () => Boolean(props.clearable && selected() && !props.disabled);
  const accessibleLabel = () =>
    props["aria-label"] ?? (typeof props.label === "string" ? undefined : (props.placeholder ?? "Select option"));
  const popover = createChoicePopover(() => Boolean(props.disabled));
  const focusedOption = () => options()[focusedIndex()];
  const focus = (index: number) => {
    setFocusedIndex(index);
    optionRefs[index]?.scrollIntoView({ block: "nearest" });
  };
  const move = (direction: 1 | -1) => focus(nextEnabledChoiceIndex(options(), focusedIndex(), direction));
  const chooseGroup = (group: string | null) => {
    if (group === activeGroup()) return;
    setSelectedGroup(group);
    setFocusedIndex(nextEnabledChoiceIndex(options(), -1, 1));
    if (isAsync()) loader.load(query(), true);
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
    if (isAsync()) loader.load("", true);
    const selectedIndex = options().findIndex((option) => option.value === value());
    focus(selectedIndex >= 0 ? selectedIndex : nextEnabledChoiceIndex(options(), -1, 1));
    popover.show();
    if (isSearchable()) queueMicrotask(() => searchRef?.focus());
  };
  const close = (restoreFocus = false) => {
    // Hide the top-layer surface before any reactive cleanup or consumer
    // callback can rerender its contents. Selection must feel atomic: the old
    // listbox must never remain visible with the next value.
    popover.hide(restoreFocus);
    loader.cancel();
    setQuery("");
    setFocusedIndex(-1);
  };
  const select = (option: NormalizedOption) => {
    if (option.disabled) return;
    close(true);
    setCache({ ...cache(), [option.value]: option });
    commitFieldValue(props, option.value);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const inToolbar = Boolean((event.target as HTMLElement | null)?.closest?.(".k2b-choice-toolbar"));
    if (inToolbar && event.key !== "Escape" && event.key !== "Tab") return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!popover.open()) open();
      else move(event.key === "ArrowDown" ? 1 : -1);
    } else if ((event.key === "Enter" || event.key === " ") && !popover.open()) {
      event.preventDefault();
      open();
    } else if (event.key === "Enter" && focusedOption()) {
      event.preventDefault();
      select(focusedOption()!);
    } else if (event.key === "Escape" && popover.open()) {
      // Only swallow Escape while the list is open — a closed select must let
      // the key bubble to an enclosing dialog or drawer.
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab" && popover.open()) close();
  };
  const clear = (event: MouseEvent) => {
    event.stopPropagation();
    commitFieldValue(props, null);
    popover.trigger()?.focus();
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
      <div class="k2b-choice-control" data-invalid={error() ? "true" : undefined}>
        <button
          ref={popover.setTrigger}
          id={meta.controlId}
          type="button"
          class="k2b-choice-trigger"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={popover.open()}
          aria-controls={listboxId}
          aria-activedescendant={focusedOption() ? `${listboxId}-${focusedIndex()}` : undefined}
          data-clearable={hasClearAction() ? "true" : undefined}
          {...fieldControlAria(meta, {
            ...props,
            "aria-label": accessibleLabel(),
          })}
          disabled={props.disabled}
          onClick={() => (popover.open() ? close() : open())}
          onKeyDown={onKeyDown}
        >
          <Show
            when={selected()?.color}
            fallback={<Show when={selected()?.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>}
          >
            {(color) => <span class="k2b-choice-dot" style={{ "background-color": color() }} aria-hidden="true" />}
          </Show>
          <span class="k2b-choice-trigger__value" data-placeholder={selected() ? undefined : "true"}>
            {selected()?.label ?? props.placeholder ?? "Select..."}
          </span>
          <Show when={!hasClearAction()}>
            <i
              class={popover.open() ? (props.activeIcon ?? "ti ti-chevron-up") : (props.icon ?? "ti ti-chevron-down")}
              aria-hidden="true"
            />
          </Show>
        </button>
        <Show when={props.name}>{(name) => <input type="hidden" name={name()} value={value() ?? ""} />}</Show>
        <Show when={hasClearAction()}>
          <button type="button" class="k2b-choice-control__clear k2b-input-clear-action" aria-label="Clear selection" onClick={clear}>
            <i class="ti ti-x" aria-hidden="true" />
          </button>
        </Show>
        <div
          ref={popover.setPopover}
          popover="manual"
          class="k2b-choice-popover"
          role="group"
          onKeyDown={onKeyDown}
          aria-label={typeof props.label === "string" ? props.label : "Options"}
        >
          <Show when={isSearchable()}>
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
                  setQuery(event.currentTarget.value);
                  if (isAsync()) loader.load(event.currentTarget.value);
                  focus(isAsync() ? -1 : nextEnabledChoiceIndex(options(), -1, 1));
                }}
              />
            </div>
          </Show>
          <Show when={(props.groups?.length ?? 0) > 0 || props.viewToggle}>
            <div class="k2b-choice-toolbar">
              <Show when={(props.groups?.length ?? 0) > 0}>
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
              </Show>
              <Show when={props.viewToggle}>
                <button
                  type="button"
                  class="k2b-choice-view-toggle"
                  aria-label={activeView() === "list" ? "Show grid view" : "Show list view"}
                  aria-controls={listboxId}
                  onClick={() => setSelectedView(activeView() === "list" ? "grid" : "list")}
                >
                  <i class={activeView() === "list" ? "ti ti-category-2" : "ti ti-list-details"} aria-hidden="true" />
                </button>
              </Show>
            </div>
          </Show>
          <div
            id={listboxId}
            class="k2b-choice-options"
            role="listbox"
            data-view={activeView()}
            data-grid-size={activeView() === "grid" ? (props.gridSize ?? "md") : undefined}
          >
            <Show when={loader.error()}>
              {(message) => (
                <div class="k2b-choice-status" data-tone="danger">
                  <span>{message()}</span>
                  <button type="button" onClick={loader.retry}>
                    Retry
                  </button>
                </div>
              )}
            </Show>
            <Show when={loader.loading() && options().length === 0}>
              <div class="k2b-choice-status">
                <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
                <span>Loading...</span>
              </div>
            </Show>
            <For
              each={loader.error() ? [] : options()}
              fallback={
                <Show when={!loader.loading() && !loader.error()}>
                  <div class="k2b-choice-status">{isSearchable() ? "No results" : "No options available"}</div>
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
                  aria-selected={option.value === value()}
                  data-focused={index() === focusedIndex() ? "true" : undefined}
                  disabled={option.disabled}
                  onPointerMove={() => focus(index())}
                  onClick={() => select(option)}
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

export default Select;
