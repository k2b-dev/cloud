import { createMemo, type JSX, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";
import type { ButtonVariant } from "./Button";
import Dropdown, { type DropdownItem } from "./Dropdown";
import { useFilterMessages } from "./filter-messages";

export type FilterChipOption = {
  value: string;
  label: string;
  icon?: string;
  color?: string;
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
      }));
      if (section.label || section.layout) result.push({ sectionLabel: section.label, layout: section.layout, items });
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
        <i class={props.icon} aria-hidden="true" />
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
