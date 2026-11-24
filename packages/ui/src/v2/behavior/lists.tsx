/**
 * Listbox and Tree behaviour for v2 `List` and `Nav`, each one core primitive through the adapter. Roving focus or
 * active descendant, arrows, Home, End, typeahead, selection, expanding and collapsing, `aria-current` are core's.
 * Ours: the item context a tree needs (each item names its parent) and the announcements in the render locale.
 */
import { listbox as listboxPrimitive } from "@ui-sdk/core/listbox";
import { tree as treePrimitive } from "@ui-sdk/core/tree";
import { createContext, type JSX, splitProps, useContext } from "solid-js";
import { type Handle, type PartProps, part, type SlotComponent, slotComponent, usePrimitive } from "./adapter";
import { type BehaviorMessages, useBehaviorMessages } from "./messages";

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

// ── Tree ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type TreeOptions = {
  /** `"none"` for navigation (no selection; `current` marks the page), `"single"` (default) or `"multiple"`. */
  mode?: "none" | "single" | "multiple";
  value?: string | string[] | null;
  defaultValue?: string | string[] | null;
  onValueChange?: (value: string | string[] | null) => void;
  expanded?: string[];
  defaultExpanded?: string[];
  onExpandedChange?: (expanded: string[]) => void;
  /** Whether a press on a branch's row expands it (default true); its indicator always does. */
  expandOnPress?: boolean;
  /** The item of the current page: `aria-current="page"`, the first tab stop, its ancestors expanded. */
  current?: string | null;
  /** A press or Enter on an item, like opening a folder. A Promise marks the item pending until it settles. */
  onAction?: (value: string) => unknown;
  /** Loads a branch's children the first time it expands while it has none. */
  loadChildren?: (value: string, details: { signal: AbortSignal }) => void | Promise<unknown>;
};

type TreeChange = { type: "expanded" | "collapsed" | "loading" | "load-failed"; label: string };

const treeAnnouncement =
  (t: () => BehaviorMessages) =>
  ({ type, label }: TreeChange): string =>
    type === "expanded"
      ? t().treeExpanded({ label })
      : type === "collapsed"
        ? t().treeCollapsed({ label })
        : type === "loading"
          ? t().treeLoading({ label })
          : t().treeLoadFailed({ label });

/** Each tree item tells core its parent, so items read the value of the item around them. */
const ItemContext = createContext<() => string>();

export type TreeParts = {
  /** The tree; takes `aria-label` or `aria-labelledby`. */
  Root: SlotComponent;
  /**
   * One item: `value`, `label` (typeahead), `disabled`, and `branch` for an item with children (the server renders
   * its expanded state from it). Its `Label`, `Indicator` and `Group` go inside.
   */
  Item: (props: PartProps & { value: string; label?: string; branch?: boolean; disabled?: boolean }) => JSX.Element;
  /** The row's text, the part a press and the keys act on. */
  Label: SlotComponent;
  /** The expand and collapse mark of a branch. */
  Indicator: SlotComponent;
  /** The children of a branch; present only while it is expanded. */
  Group: SlotComponent;
};

/** A tree: levels, expanding and collapsing, arrows, Home, End and typeahead come from core. */
export function useTree(options: () => TreeOptions = () => ({})): TreeParts {
  const t = useBehaviorMessages();
  const announcement = treeAnnouncement(t);
  const handle = usePrimitive(treePrimitive, () => {
    const given = options();
    const onAction = given.onAction;
    return { ...given, onAction: onAction && ((value: string) => onAction(value)), announcement, pendingAnnouncement: t().loading };
  });
  return {
    Root: slotComponent(handle, "root", "div"),
    Item: (props) => {
      const parent = useContext(ItemContext);
      const [own, rest] = splitProps(props, ["value", "label", "branch", "disabled"]);
      const itemProps = () => ({
        value: own.value,
        parent: parent ? parent() : null,
        branch: own.branch,
        disabled: own.disabled,
        label: own.label,
      });
      return <ItemContext.Provider value={() => own.value}>{part(handle, "item", itemProps, rest, "div")}</ItemContext.Provider>;
    },
    Label: itemPart(handle, "label", "span"),
    Indicator: itemPart(handle, "indicator", "span"),
    Group: itemPart(handle, "group", "div"),
  };
}

/** A part of the tree item around it: it takes that item's value. */
const itemPart =
  (handle: Handle<typeof treePrimitive>, slot: "label" | "indicator" | "group", tag: string): SlotComponent =>
  (props) => {
    const item = useContext(ItemContext);
    if (!item) throw new Error(`A tree ${slot} must be inside a tree item.`);
    return part(handle, slot, () => ({ value: item() }), props, tag);
  };
