import { fuzzy } from "@k2b/stdlib";
import { createMemo, type JSX } from "solid-js";
import { useUiMessages } from "../intl/messages";
import type { ValueFieldProps } from "./field-contract";
import { resolveMaybeAccessor } from "./field-contract";
import { DEFAULT_ICON_GROUPS, DEFAULT_ICON_OPTIONS } from "./icon-options";
import { Select, type SelectGridSize, type SelectGroup, type SelectOption, type SelectView } from "./Select";

export type IconOption = SelectOption & { keywords?: readonly string[] };
export type IconInputProps = ValueFieldProps<string | null> & {
  options?: readonly IconOption[];
  placeholder?: string;
  clearable?: boolean;
  searchLimit?: number;
  groups?: readonly SelectGroup[];
  defaultGroup?: string;
  groupsAriaLabel?: string;
  allGroupLabel?: string;
  viewToggle?: boolean;
  defaultView?: SelectView;
  gridSize?: SelectGridSize;
  name?: string;
};

export function IconInput(props: IconInputProps): JSX.Element {
  const messages = useUiMessages();
  const options = () => props.options ?? DEFAULT_ICON_OPTIONS;
  const groups = () => props.groups ?? (props.options === undefined ? DEFAULT_ICON_GROUPS : undefined);
  const filterOptions = (source: readonly SelectOption[], query: string): readonly SelectOption[] => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return [...source].sort((left, right) => String(left.label).localeCompare(String(right.label), undefined, { sensitivity: "base" }));
    }
    return fuzzy
      .filter(normalized, source, {
        // Cloud's key is `[label, ...keywords]`. Including `value` as well put
        // the literal "ti ti-" in front of every entry, so short queries matched
        // the whole catalogue and fuzzy scores were skewed. The bare glyph name
        // is already the first keyword (see `icon()` in ./icon-options), so
        // nothing is lost by dropping it.
        key: (option) => {
          const keywords = "keywords" in option && Array.isArray(option.keywords) ? option.keywords.join(" ") : "";
          return `${String(option.label)} ${keywords}`.toLowerCase();
        },
        limit: props.searchLimit ?? 50,
      })
      .map((match) => match.item);
  };
  const selectedOption = createMemo(() => options().find((option) => option.value === resolveMaybeAccessor(props.value)));

  return (
    <Select
      id={props.id}
      name={props.name}
      class={props.class}
      label={props.label}
      description={props.description}
      error={props.error}
      aria-label={props["aria-label"]}
      aria-describedby={props["aria-describedby"]}
      placeholder={props.placeholder ?? messages().pickIcon}
      disabled={props.disabled}
      required={props.required}
      clearable={props.clearable ?? true}
      value={resolveMaybeAccessor(props.value)}
      selectedOption={selectedOption()}
      onValueChange={props.onValueChange}
      onValueCommit={props.onValueCommit}
      options={[...options()]}
      groups={groups()}
      defaultGroup={props.defaultGroup ?? (props.options === undefined ? "recommended" : undefined)}
      groupsAriaLabel={props.groupsAriaLabel ?? messages().filterIcons}
      allGroupLabel={props.allGroupLabel}
      viewToggle={props.viewToggle ?? true}
      defaultView={props.defaultView ?? "grid"}
      gridSize={props.gridSize ?? "sm"}
      searchable
      filterOptions={filterOptions}
      searchPlaceholder={messages().search}
      icon={selectedOption()?.icon ?? "ti ti-icons"}
    />
  );
}
