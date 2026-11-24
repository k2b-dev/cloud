/**
 * Menu behaviour beyond `useMenu`: submenus, check items and the context menu. Arrows, typeahead, opening a submenu
 * to the side (hover with its safe triangle, ArrowRight, ArrowLeft back), right-click, long press, Shift+F10, Escape,
 * focus return and placement at the pointer are core's. Each level is one core instance; a submenu's instance names
 * its parent, so its trigger is an item of the parent menu. No ui-sdk type crosses this module's exports.
 */
import { menu as menuPrimitive } from "@ui-sdk/core/menu";
import { menuCheckable, menuContextTrigger } from "@ui-sdk/core/renderer";
import { type Handle, popupComponent, type SlotComponent, slotComponent, usePrimitive } from "./adapter";
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
  /** An item that toggles: `value`, `label`, `checked`, `onCheckedChange`. */
  CheckboxItem: SlotComponent;
  Separator: SlotComponent;
  /**
   * Makes an element that is already on the page the menu's context area: a right-click or a long press opens the
   * menu at the pointer, Shift+F10 and the context menu key at the element. Core attaches its own listeners, so the
   * area needs no wrapper element. Returns the function that lets go of it.
   */
  bindContext: (element: HTMLElement) => () => void;
  /** A submenu of this level. Call it in a component under this level's popup. */
  useSubmenu: () => MenuLevelParts;
};

type MenuHandle = Handle<typeof menuPrimitive>;

let contextAreas = 0;

const levelParts = (handle: MenuHandle): MenuLevelParts => {
  handle.instance.use(menuCheckable);
  return {
    Trigger: slotComponent(handle, "trigger", "button"),
    Popup: popupComponent(handle, "content"),
    Item: slotComponent(handle, "item", "div"),
    LinkItem: slotComponent(handle, "item", "a"),
    CheckboxItem: slotComponent(handle, "checkbox-item", "div"),
    Separator: slotComponent(handle, "separator", "div"),
    bindContext: (element) => {
      handle.instance.use(menuContextTrigger);
      contextAreas += 1;
      return bindSlot(handle, "context-trigger", { id: `k2-context-${contextAreas}` }, element);
    },
    useSubmenu: () => levelParts(usePrimitive(menuPrimitive, () => ({ parent: handle.api }))),
  };
};

/** A menu with submenus, check items and an optional context area. */
export function useMenuLevels(options: () => OverlayOptions = () => ({})): MenuLevelParts {
  // A pending item announces that it is waiting; core's own text is English only.
  const t = useBehaviorMessages();
  return levelParts(usePrimitive(menuPrimitive, () => ({ ...options(), pendingAnnouncement: t().loading })));
}
