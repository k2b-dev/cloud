import { createMemo, type JSX, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";
import Dropdown, { type DropdownItem } from "./Dropdown";

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
  class?: string;
};

/** Section-aware controlled filter with immediate single- and multi-select commits. */
export function FilterChip(props: FilterChipProps): JSX.Element {
  const messages = useUiMessages();
  const selectedValues = createMemo(() => new Set(props.value));
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
      if (section.label) result.push({ sectionLabel: section.label, items });
      else result.push(...items);
    }
    return result;
  });
  const items = createMemo<DropdownItem[]>(() => {
    if (!showReset()) return optionItems();
    return [
      ...optionItems(),
      {
        sectionLabel: messages().filterActions,
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
    <Dropdown.Root items={items()} position={props.position ?? "bottom-left"} width="13rem" label={props.label}>
      <Dropdown.Trigger
        appearance="plain"
        class={`k2b-filter-chip ${props.class ?? ""}`}
        data-state={active() ? "active" : "idle"}
        data-active={active() ? "true" : undefined}
        data-icon-only={props.iconOnly ? "true" : undefined}
        label={props.label}
        title={props.iconOnly ? props.label : undefined}
      >
        <i class={props.icon} aria-hidden="true" />
        <Show when={!props.iconOnly}>
          <span>
            {props.label}
            <Show when={!hasDefault() && props.value.length > 0}>{` (${props.value.length})`}</Show>
          </span>
          <i class="ti ti-chevron-down k2b-filter-chip__chevron" aria-hidden="true" />
        </Show>
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}

export default FilterChip;
