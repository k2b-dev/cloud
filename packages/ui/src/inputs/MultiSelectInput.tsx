import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { colorTintStyle, normalizeHexColor } from "../internal/color";
import { createFieldMeta, Field, fieldControlAria } from "../internal/field";
import { useUiMessages } from "../intl/messages";
import { ChoiceGroups } from "./ChoiceGroups";
import {
  type ChoiceOption,
  createChoiceLoader,
  createChoicePopover,
  filterChoiceOptions,
  fitChoicePills,
  nextEnabledChoiceIndex,
} from "./choice";
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
  const messages = useUiMessages();
  const meta = createFieldMeta(props.id);
  const listboxId = `${meta.controlId}-listbox`;
  const [query, setQuery] = createSignal("");
  const [focusedIndex, setFocusedIndex] = createSignal(-1);
  const [cache, setCache] = createSignal<Record<string, NormalizedOption>>({});
  const [selectedGroup, setSelectedGroup] = createSignal<string | null>(props.defaultGroup ?? null);
  let searchRef: HTMLInputElement | undefined;

  const values = () => resolveMaybeAccessor(props.value) ?? [];
  const error = () => resolveMaybeAccessor(props.error);
  const activeGroup = createMemo(() => {
    const current = selectedGroup();
    return current && props.groups?.some((group) => group.value === current) ? current : null;
  });
  const groupChoices = createMemo(() => [{ value: null, label: props.allGroupLabel ?? messages().all }, ...(props.groups ?? [])]);
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

  // Pills that do not fit the trigger collapse into a "+N" summary. Until the
  // browser measures them (server HTML, hidden containers) every pill stays.
  let valuesRef: HTMLSpanElement | undefined;
  let moreRef: HTMLSpanElement | undefined;
  const [visibleCount, setVisibleCount] = createSignal(Number.POSITIVE_INFINITY);
  const hiddenOptions = createMemo(() => selected().slice(visibleCount()));
  // While every pill fits, the invisible summary carries the largest count it
  // could show, so measuring it reserves enough room for the real one.
  const moreCount = () => hiddenOptions().length || selected().length - 1;
  const fitValues = () => {
    const values = valuesRef;
    if (!values?.isConnected) return;
    // Measuring releases a truncated first pill to its natural width; the
    // browser paints only the final state.
    values.dataset.measuring = "true";
    const pills = Array.from(
      values.querySelectorAll<HTMLElement>(":scope > .k2b-choice-pill"),
      (pill) => pill.getBoundingClientRect().width,
    );
    const fit = fitChoicePills(
      values.getBoundingClientRect().width,
      pills,
      Number.parseFloat(getComputedStyle(values).columnGap) || 0,
      moreRef?.isConnected ? moreRef.getBoundingClientRect().width : 0,
    );
    delete values.dataset.measuring;
    // Hidden pills leave the flow. While any are hidden the strip keeps the
    // whole row as its preferred width, so a container sized by its content
    // does not shrink with the collapse and grows back once it has room. The
    // strip still flexes to the trigger's width.
    values.style.width = fit.visible < pills.length ? `${fit.rowWidth}px` : "";
    setVisibleCount(fit.visible);
  };
  const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => fitValues());
  onCleanup(() => resizeObserver?.disconnect());
  createEffect(() => {
    selected();
    fitValues();
  });
  onMount(() => {
    if ("fonts" in document) void document.fonts.ready.then(fitValues);
  });

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
          ref={(element) => {
            popover.setTrigger(element);
            resizeObserver?.observe(element);
          }}
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
                {props.placeholder ?? messages().select}
              </span>
            }
          >
            <span
              ref={valuesRef}
              class="k2b-multi-select-trigger__values"
              data-overflowing={hiddenOptions().length > 0 ? "true" : undefined}
            >
              <For each={selected()}>
                {(option, index) => (
                  <span
                    class="k2b-choice-pill"
                    style={colorTintStyle(option.color)}
                    title={option.label}
                    data-hidden={index() >= visibleCount() ? "true" : undefined}
                  >
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
                      aria-label={messages().removeNamed({ name: option.label })}
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
              <Show when={selected().length > 1}>
                <span
                  ref={(element) => {
                    moreRef = element;
                    resizeObserver?.observe(element);
                    onCleanup(() => resizeObserver?.unobserve(element));
                  }}
                  class="k2b-multi-select-trigger__more"
                  title={
                    hiddenOptions()
                      .map((option) => option.label)
                      .join(", ") || undefined
                  }
                  data-hidden={hiddenOptions().length === 0 ? "true" : undefined}
                >
                  <span aria-hidden="true">+{moreCount()}</span>
                  <span class="k2b-sr-only">{messages().moreSelected({ count: moreCount() })}</span>
                </span>
              </Show>
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
            aria-label={props.clearLabel ?? messages().clearSelection}
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
          aria-label={typeof props.label === "string" ? props.label : (props["aria-label"] ?? messages().options)}
        >
          <Show when={searchable()}>
            <div class="k2b-choice-search">
              <i class="ti ti-search" aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                value={query()}
                placeholder={props.searchPlaceholder ?? messages().search}
                aria-label={props.searchPlaceholder ?? messages().searchOptions}
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
              <ChoiceGroups
                choices={groupChoices()}
                value={activeGroup()}
                onValueChange={chooseGroup}
                ariaLabel={props.groupsAriaLabel ?? messages().filterOptions}
                controls={listboxId}
              />
            </div>
          </Show>
          <div id={listboxId} class="k2b-choice-options" role="listbox" aria-multiselectable="true">
            <Show when={asyncOptions.error()}>
              {(message) => (
                <div class="k2b-choice-status" data-tone="danger">
                  <span>{message()}</span>
                  <button type="button" onClick={asyncOptions.retry}>
                    {props.retryLabel ?? messages().retry}
                  </button>
                </div>
              )}
            </Show>
            <Show when={asyncOptions.loading() && visibleOptions().length === 0}>
              <div class="k2b-choice-status">
                <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
                <span>{props.loadingLabel ?? messages().loading}</span>
              </div>
            </Show>
            <For
              each={asyncOptions.error() ? [] : visibleOptions()}
              fallback={
                <Show when={!asyncOptions.loading() && !asyncOptions.error()}>
                  <div class="k2b-choice-status">
                    {isAsync() || query() ? (props.noResultsLabel ?? messages().noResults) : (props.emptyLabel ?? messages().noOptions)}
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
