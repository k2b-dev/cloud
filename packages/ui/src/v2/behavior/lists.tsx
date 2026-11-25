/**
 * Listbox behaviour for v2 lists to choose from (`Lookup`, the filter bar), one core primitive through the adapter.
 * Roving focus or active descendant, arrows, Home, End, typeahead and selection are core's. (`Nav` is a disclosure
 * navigation of links, not a tree.)
 */
import { listbox as listboxPrimitive } from "@ui-sdk/core/listbox";
import { type SlotComponent, slotComponent, usePrimitive } from "./adapter";

// ── Listbox ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ListboxOptions = {
  value?: string | string[] | null;
  defaultValue?: string | string[] | null;
  onValueChange?: (value: string | string[] | null) => void;
  /** Several values; Space and a press toggle one. */
  multiple?: boolean;
  /** `"automatic"`: moving the highlight selects; `"manual"` (default in core): Space or a press does. */
  activation?: "automatic" | "manual";
  orientation?: "vertical" | "horizontal";
  loop?: boolean;
  disabled?: boolean;
};

export type ListboxParts = {
  /** The list; takes `aria-label` or `aria-labelledby`. */
  Root: SlotComponent;
  /** One row: `value`, `label` (for typeahead), `disabled`. */
  Item: SlotComponent;
  /** The mark of a selected row; pass the row's value as `item`. */
  ItemIndicator: SlotComponent;
  Group: SlotComponent;
  GroupLabel: SlotComponent;
  Separator: SlotComponent;
};

/** A listbox: rows to choose from with the keyboard and the pointer, one or several. */
export function useListbox(options: () => ListboxOptions = () => ({})): ListboxParts {
  const handle = usePrimitive(listboxPrimitive, options);
  return {
    Root: slotComponent(handle, "root", "div"),
    Item: slotComponent(handle, "item", "div"),
    ItemIndicator: slotComponent(handle, "item-indicator", "span"),
    Group: slotComponent(handle, "group", "div"),
    GroupLabel: slotComponent(handle, "group-label", "div"),
    Separator: slotComponent(handle, "separator", "div"),
  };
}
