/**
 * Tree behaviour for the v2 `Nav`, one core primitive through the adapter: levels, expanding and collapsing, arrows,
 * Home, End, typeahead and `aria-current` are core's. Ours: the item context a tree needs (each item names its parent)
 * and the announcements in the render locale.
 */
import { Link } from "@k2b/ssr/nav";
import { createTreeController, type TreeController, tree as treePrimitive } from "@ui-sdk/core/tree";
import { createContext, type JSX, splitProps, useContext, type ValidComponent } from "solid-js";
import { type Handle, type PartProps, part, type SlotComponent, slotComponent, usePrimitive } from "./adapter";
import { type BehaviorMessages, useBehaviorMessages } from "./messages";

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
  /**
   * The item of the current page: `aria-current="page"` and the first tab stop. Core only knows rendered items, and
   * the children of a collapsed branch are not rendered, so a nested current needs its ancestors in `defaultExpanded`
   * (or `expanded`).
   */
  current?: string | null;
  /** A press or Enter on an item, like opening a folder. A Promise marks the item pending until it settles. */
  onAction?: (value: string, details: { event?: Event }) => unknown;
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
  /**
   * The row's text as a link (`href`, `onNavigate`), in the place of `Label`: core leaves the tab order to the item
   * and Enter on the item follows the link.
   */
  Link: (props: PartProps & { href: string; onNavigate?: unknown }) => JSX.Element;
  /** Drives the tree from outside: expand, collapse, focus an item (core's `createTreeController`). */
  controller: TreeController;
};

/** A tree: levels, expanding and collapsing, arrows, Home, End and typeahead come from core. */
export function useTree(options: () => TreeOptions = () => ({})): TreeParts {
  const t = useBehaviorMessages();
  const announcement = treeAnnouncement(t);
  const controller = createTreeController();
  const handle = usePrimitive(treePrimitive, () => {
    const given = options();
    const onAction = given.onAction;
    return {
      ...given,
      controller,
      onAction: onAction && ((value: string, details: { event?: Event }) => onAction(value, details)),
      announcement,
      pendingAnnouncement: t().loading,
    };
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
    Link: itemPart(handle, "label", Link),
    controller,
  };
}

/** A part of the tree item around it: it takes that item's value; a group also takes `keepMounted`, `hiddenUntilFound`. */
const itemPart =
  (handle: Handle<typeof treePrimitive>, slot: "label" | "indicator" | "group", tag: ValidComponent): SlotComponent =>
  (props) => {
    const item = useContext(ItemContext);
    if (!item) throw new Error(`A tree ${slot} must be inside a tree item.`);
    // Slot props go to core, never onto the element as attributes.
    const [own, rest] = splitProps(props, ["keepMounted", "hiddenUntilFound"]);
    return part(handle, slot, () => ({ value: item(), keepMounted: own.keepMounted, hiddenUntilFound: own.hiddenUntilFound }), rest, tag);
  };
