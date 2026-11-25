/**
 * Menu behaviour beyond `useMenu`: submenus, check items and the context menu. Arrows, typeahead, opening a submenu
 * to the side (hover with its safe triangle, ArrowRight, ArrowLeft back), right-click, long press, Shift+F10, Escape,
 * focus return and placement at the pointer are core's. Each level is one core instance; a submenu's instance names
 * its parent, so its trigger is an item of the parent menu. No ui-sdk type crosses this module's exports.
 */

import { Link } from "@k2b/ssr/nav";
import type { SlotName } from "@ui-sdk/core";
import { menu as menuPrimitive } from "@ui-sdk/core/menu";
import { menuCheckable, menuContextTrigger } from "@ui-sdk/core/renderer";
import { splitProps } from "solid-js";
import { type Handle, keyed, type Props, part, popupComponent, type SlotComponent, slotComponent, usePrimitive } from "./adapter";
import { bindSlot } from "./bind";
import { useBehaviorMessages } from "./messages";
import type { OverlayOptions } from "./overlays";

export type MenuLevelParts = {
  /** Opens the menu. In a submenu it is an item of the parent menu. */
  Trigger: SlotComponent;
  /** The menu with its items; renders only while open. Takes `Placement` props. */
  Popup: SlotComponent;
  /** One action: `value` names it, `label` feeds typeahead, `onSelect` runs it (a Promise keeps the menu open). */
  Item: SlotComponent;
  /** An item that is a link (`href`); core follows it and closes the menu. */
  LinkItem: SlotComponent;
  /**
   * An item that is a link opened in place: `href` and `onNavigate`, rendered as `@k2b/ssr/nav`'s `Link`, so a plain
   * click (or Enter) calls `onNavigate` as a tab or a row does, and a modified click opens a new tab.
   */
  NavLinkItem: SlotComponent;
  /** An item that toggles: `value`, `label`, `checked`, `onCheckedChange`. */
  CheckboxItem: SlotComponent;
  /** One choice among its items: `name` (also what its `GroupLabel` names), `value`, `onValueChange`. */
  RadioGroup: SlotComponent;
  /** An item of a radio group: `group` (the group's name), `value`, `label`, `closeOnSelect`. */
  RadioItem: SlotComponent;
  /** Entries that belong together, labelled by a `GroupLabel` with the same `group` as this `id`. */
  Group: SlotComponent;
  /** The heading of a group or radio group: `group` is the group's `id` or the radio group's `name`. */
  GroupLabel: SlotComponent;
  Separator: SlotComponent;
  /**
   * Makes an element that is already on the page the menu's context area: a right-click or a long press opens the
   * menu at the pointer, Shift+F10 and the context menu key at the element. Core attaches its own listeners, so the
   * area needs no wrapper element. Returns the function that lets go of it.
   */
  bindContext: (element: HTMLElement) => () => void;
  /** A submenu of this level. Call it in a component under this level's popup. */
  useSubmenu: () => MenuLevelParts;
  /** Closes the whole menu, as choosing an entry does; for a panel that picks something. */
  close: () => void;
  /** Closes this submenu and puts the focus back on its entry, as Escape in a submenu does. */
  back: () => void;
};

type MenuHandle = Handle<typeof menuPrimitive>;

/**
 * A slot a feature adds (`checkbox-item`, `radio-group`, `radio-item`): it is not in the primitive's own schema, so
 * its props are named here instead of looked up (k2b-ui gap #4112). `key` gives the props that key the part.
 */
const featurePart =
  (handle: MenuHandle, slot: string, names: readonly string[], key: (own: Props) => Props): SlotComponent =>
  (props) => {
    const [own, element] = splitProps(props, names);
    const slotProps = () => {
      const given = Object.fromEntries(names.map((name) => [name, own[name]]).filter(([, value]) => value !== undefined));
      return { ...given, ...key(own) };
    };
    return part(handle, slot as SlotName<typeof menuPrimitive>, slotProps, element, "div");
  };

let contextAreas = 0;

const levelParts = (handle: MenuHandle): MenuLevelParts => {
  handle.instance.use(menuCheckable);
  return {
    Trigger: slotComponent(handle, "trigger", "button"),
    Popup: popupComponent(handle, "content"),
    Item: slotComponent(handle, "item", "div"),
    LinkItem: slotComponent(handle, "item", "a"),
    NavLinkItem: slotComponent(handle, "item", Link),
    CheckboxItem: featurePart(
      handle,
      "checkbox-item",
      ["value", "label", "checked", "disabled", "onCheckedChange", "closeOnSelect"],
      (own) => keyed(handle, String(own.value)),
    ),
    // a radio group's key is its name, and an item's key holds its group, since two groups may share values
    RadioGroup: featurePart(handle, "radio-group", ["name", "value", "onValueChange"], (own) => ({ id: own.name })),
    RadioItem: featurePart(handle, "radio-item", ["group", "value", "label", "disabled", "closeOnSelect"], (own) => ({
      id: `${String(own.group)}-${String(own.value)}`,
    })),
    Group: slotComponent(handle, "group", "div"),
    GroupLabel: slotComponent(handle, "group-label", "div"),
    Separator: slotComponent(handle, "separator", "div"),
    bindContext: (element) => {
      handle.instance.use(menuContextTrigger);
      contextAreas += 1;
      return bindSlot(handle, "context-trigger", { id: `k2-context-${contextAreas}` }, element);
    },
    useSubmenu: () => levelParts(usePrimitive(menuPrimitive, () => ({ parent: handle.api }))),
    close: () => handle.api.action(undefined),
    back: () => {
      handle.api.hide({ reason: "escape-key", focus: false });
      handle.api.focusTriggerItem();
    },
  };
};

/** A menu with submenus, check items and an optional context area. */
export function useMenuLevels(
  options: () => OverlayOptions & {
    /** `sheet`: from the bottom of the screen, a submenu shows in its parent's place; `popover` by default. */
    presentation?: "popover" | "sheet";
  } = () => ({}),
): MenuLevelParts {
  // A pending item announces that it is waiting; core's own text is English only.
  const t = useBehaviorMessages();
  return levelParts(usePrimitive(menuPrimitive, () => ({ ...options(), pendingAnnouncement: t().loading })));
}
