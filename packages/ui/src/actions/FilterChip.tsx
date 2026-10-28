import { createMemo, For, type JSX, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";
import type { ButtonVariant } from "./Button";
import Dropdown, { type DropdownItem } from "./Dropdown";
import { useFilterMessages } from "./filter-messages";

export type FilterChipOption = {
  value: string;
  label: string;
  icon?: string;
  color?: string;
  /** Quiet trailing information about the option, such as a short note or a loading or warning icon with its own label. */
  trailing?: JSX.Element;
};

export type FilterChipSection = {
  label?: string;
  options: readonly FilterChipOption[];
  multiple?: boolean;
  /**
   * `row` sets a few short single-select options side by side as one segmented row under its `label`. Selecting the
   * chosen option again keeps it; give the row a value in `defaultValue` so Reset keeps a choice too.
   */
  layout?: "row";
  /** A labelled `multiple` section offers "All" or, once all its options are chosen, "None" beside its label. */
  toggleAll?: boolean;
};

export type FilterChipProps = {
  label: string;
  icon: string;
  options: readonly FilterChipSection[];
  value: readonly string[];
  onValueChange: (value: string[]) => void;
  isActive?: boolean;
  position?: "bottom-left" | "bottom-right";
  defaultValue?: readonly string[];
  iconOnly?: boolean;
  /** Use a standard button appearance instead of the default filter field. */
  variant?: ButtonVariant;
  /**
   * An active chip names its first value instead of a count: "Tags: Customer", "Tags: Customer +2". Use it for the
   * chips of `AppWorkspace.Head`; pass only the filter's name as `label`. The chip then grows with its value.
   */
  showValue?: boolean;
  /**
   * Each option of a `multiple` section offers "Only" at the end of its row: it chooses that option alone among the
   * `multiple` sections and keeps the choices of single-select sections.
   */
  only?: boolean;
  /** The trigger shows the colors of the first four chosen options before its label, as a quiet hint of what is in view. */
  swatches?: boolean;
  disabled?: boolean;
  class?: string;
};

/** Section-aware controlled filter with immediate single- and multi-select commits. */
export function FilterChip(props: FilterChipProps): JSX.Element {
  const messages = useUiMessages();
  const filterMessages = useFilterMessages();
  const selectedValues = createMemo(() => new Set(props.value));
  const selectedOptions = createMemo(() =>
    props.options.flatMap((section) => section.options).filter((option) => selectedValues().has(option.value)),
  );
  const defaultValues = createMemo(() => new Set(props.defaultValue ?? []));
  const sectionByValue = createMemo(() => {
    const sections = new Map<string, FilterChipSection>();
    for (const section of props.options) {
      for (const option of section.options) sections.set(option.value, section);
    }
    return sections;
  });
  const hasDefault = () => (props.defaultValue?.length ?? 0) > 0;
  const selected = (value: string) => selectedValues().has(value);
  const active = () => props.isActive ?? props.value.length > 0;
  const namedValue = () => (props.showValue && !props.iconOnly && active() ? selectedOptions()[0] : undefined);
  const triggerLabel = () => {
    const first = namedValue();
    if (!first) return props.label;
    return `${props.label}: ${first.label}${props.value.length > 1 ? ` +${props.value.length - 1}` : ""}`;
  };
  const atDefault = () => {
    if (!props.defaultValue) return false;
    const current = props.value;
    return current.length === props.defaultValue.length && current.every((value) => defaultValues().has(value));
  };
  const emit = (value: string[]) => props.onValueChange(value);
  const toggle = (value: string) => {
    const section = sectionByValue().get(value);
    if (!section) return;
    const current = props.value;
    if (section.multiple) {
      emit(selected(value) ? current.filter((entry) => entry !== value) : [...current, value]);
      return;
    }
    // A segmented row always keeps one choice, like a SegmentedControl.
    if (section.layout === "row" && selected(value)) return;
    const sectionValues = new Set(section.options.map((option) => option.value));
    const otherValues = current.filter((entry) => !sectionValues.has(entry));
    emit(selected(value) ? otherValues : [...otherValues, value]);
  };
  const reset = () => emit(props.defaultValue ? [...props.defaultValue] : []);
  const showReset = () => (hasDefault() && !atDefault()) || (!hasDefault() && props.value.length > 0);
  const swatches = createMemo(() =>
    props.swatches && !props.iconOnly
      ? selectedOptions()
          .flatMap((option) => (option.color ? [option.color] : []))
          .slice(0, 4)
      : [],
  );
  const onlyValue = (value: string) => {
    const kept = props.value.filter((entry) => !sectionByValue().get(entry)?.multiple);
    emit([...kept, value]);
  };
  const toggleSection = (section: FilterChipSection) => {
    const values = section.options.map((option) => option.value);
    const all = values.every((value) => selected(value));
    const others = props.value.filter((entry) => !values.includes(entry));
    emit(all ? others : [...others, ...values]);
  };
  const optionItems = createMemo<DropdownItem[]>(() => {
    const result: DropdownItem[] = [];
    for (const section of props.options) {
      const items = section.options.map((option) => ({
        action: () => toggle(option.value),
        checked: () => props.value.includes(option.value),
        choice: section.multiple ? ("checkbox" as const) : ("radio" as const),
        class: "k2b-filter-chip__option",
        closeOnSelect: false,
        color: option.color,
        icon: !section.multiple ? option.icon : undefined,
        label: option.label,
        trailing: option.trailing,
        secondary:
          props.only && section.multiple
            ? {
                label: filterMessages().only,
                ariaLabel: filterMessages().onlyOption({ label: option.label }),
                action: () => onlyValue(option.value),
              }
            : undefined,
      }));
      // Read when the row renders, so a change of the choice updates the label without rebuilding the rows.
      const all = () => section.options.every((option) => selected(option.value));
      const sectionLabel = section.label;
      const labelAction =
        section.toggleAll && section.multiple && sectionLabel && section.options.length > 0
          ? {
              get label() {
                return all() ? filterMessages().none : filterMessages().all;
              },
              get ariaLabel() {
                return (all() ? filterMessages().noneOf : filterMessages().allOf)({ label: sectionLabel });
              },
              action: () => toggleSection(section),
            }
          : undefined;
      if (section.label || section.layout) result.push({ sectionLabel: section.label, layout: section.layout, labelAction, items });
      else result.push(...items);
    }
    return result;
  });
  const items = createMemo<DropdownItem[]>(() => {
    if (!showReset()) return optionItems();
    return [
      ...optionItems(),
      {
        sectionLabel: filterMessages().filterActions,
        items: [
          {
            action: reset,
            icon: hasDefault() ? "ti ti-refresh" : "ti ti-x",
            label: hasDefault() ? messages().reset : messages().clear,
            variant: "danger",
          },
        ],
      },
    ];
  });

  return (
    <Dropdown.Root
      disabled={props.disabled}
      items={items()}
      position={props.position ?? "bottom-left"}
      menuClass="k2b-filter-chip__menu"
      label={props.label}
    >
      <Dropdown.Trigger
        appearance={props.variant ? "button" : "plain"}
        variant={props.variant}
        iconOnly={props.iconOnly}
        class={props.variant ? props.class : `k2b-filter-chip ${props.class ?? ""}`}
        data-state={active() ? "active" : "idle"}
        data-active={active() ? "true" : undefined}
        data-icon-only={props.iconOnly ? "true" : undefined}
        label={triggerLabel()}
      >
        <Show when={swatches().length > 0} fallback={<i class={props.icon} aria-hidden="true" />}>
          <span class="k2b-filter-chip__swatches" aria-hidden="true">
            <For each={swatches()}>{(color) => <span class="k2b-filter-chip__dot" style={{ "--k2b-filter-color": color }} />}</For>
          </span>
        </Show>
        <Show when={!props.iconOnly}>
          <span class="k2b-filter-chip__label">
            {props.label}
            <Show when={namedValue()} fallback={<Show when={!hasDefault() && props.value.length > 0}>{` (${props.value.length})`}</Show>}>
              {(first) => (
                <span class="k2b-filter-chip__value">
                  :{" "}
                  <Show when={first().color}>
                    {(color) => <span class="k2b-filter-chip__dot" style={{ "--k2b-filter-color": color() }} aria-hidden="true" />}
                  </Show>
                  {first().label}
                  <Show when={props.value.length > 1}>{` +${props.value.length - 1}`}</Show>
                </span>
              )}
            </Show>
          </span>
          <i class="ti ti-chevron-down k2b-filter-chip__chevron" aria-hidden="true" />
        </Show>
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}

export default FilterChip;

export type FilterToggleProps = {
  label: JSX.Element;
  icon: string;
  /** Whether the filter is on. An active toggle carries the same tint as an active `FilterChip`. */
  active: boolean;
  /** Link to the URL with the filter switched. The link keeps working without JavaScript. */
  href?: string;
  onClick?: (event: MouseEvent) => void;
  title?: string;
  disabled?: boolean;
  class?: string;
};

/**
 * One on/off filter in the chip look: a link marked `aria-current="true"` while active, or a button with
 * `aria-pressed`. Selection changes only colour and background, so neighbouring chips never move.
 */
export function FilterToggle(props: FilterToggleProps): JSX.Element {
  const content = () => (
    <>
      <i class={props.icon} aria-hidden="true" />
      <span class="k2b-filter-chip__label">{props.label}</span>
    </>
  );
  const className = () => `k2b-filter-chip ${props.class ?? ""}`;
  return (
    <Show
      when={props.href !== undefined && !props.disabled}
      fallback={
        <button
          type="button"
          class={className()}
          data-active={props.active ? "true" : undefined}
          aria-pressed={props.active}
          title={props.title}
          disabled={props.disabled}
          onClick={(event) => props.onClick?.(event)}
        >
          {content()}
        </button>
      }
    >
      <a
        class={className()}
        href={props.href}
        data-active={props.active ? "true" : undefined}
        aria-current={props.active ? "true" : undefined}
        title={props.title}
        onClick={(event) => props.onClick?.(event)}
      >
        {content()}
      </a>
    </Show>
  );
}
