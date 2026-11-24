/**
 * Dialog, Menu and Popover behaviour for v2. Focus trap, Escape, focus return, outside press, positioning, roving
 * focus and typeahead are core's. Each `use…` hook makes one instance and returns its parts as components; the v2
 * primitives add structure and look. No ui-sdk type crosses this module's exports.
 */
import { dialog as dialogPrimitive } from "@ui-sdk/core/dialog";
import { menu as menuPrimitive } from "@ui-sdk/core/menu";
import { popover as popoverPrimitive } from "@ui-sdk/core/popover";
import type { JSX } from "solid-js";
import { type PartProps, popupComponent, type SlotComponent, slotComponent, usePrimitive } from "./adapter";
import { useBehaviorMessages } from "./messages";

export type OverlayOptions = {
  /** Controlled open state; leave out for an uncontrolled overlay. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/** Where a popup sits next to its trigger. */
export type Placement = {
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  collisionPadding?: number;
};

export type DialogParts = {
  Trigger: SlotComponent;
  /** The modal content with its backdrop; renders only while open. */
  Popup: (props: PartProps & { backdrop?: PartProps }) => JSX.Element;
  Title: SlotComponent;
  Description: SlotComponent;
  Close: SlotComponent;
};

/**
 * How a dialog presents: `"sheet"` slides up from the bottom of the screen and can be swiped away; `"auto"` does that
 * on small touch screens (decided by core each time it opens; the server renders the dialog).
 */
export type Presentation = "auto" | "dialog" | "sheet";

/** A modal dialog: focus moves in and stays in, Escape and Close close it, focus returns to the trigger. */
export function useDialog(options: () => OverlayOptions & { modal?: boolean; presentation?: Presentation } = () => ({})): DialogParts {
  // An async action in the dialog announces that it is waiting; core's own text is English only.
  const t = useBehaviorMessages();
  const handle = usePrimitive(dialogPrimitive, () => ({ ...options(), pendingAnnouncement: t().loading }));
  const Backdrop = popupComponent(handle, "backdrop");
  const Content = popupComponent(handle, "content");
  return {
    Trigger: slotComponent(handle, "trigger", "button"),
    Popup: (props) => (
      <>
        <Backdrop {...(props.backdrop ?? {})} />
        <Content {...props} backdrop={undefined} />
      </>
    ),
    Title: slotComponent(handle, "title", "h2"),
    Description: slotComponent(handle, "description", "p"),
    Close: slotComponent(handle, "close", "button"),
  };
}

export type MenuParts = {
  Trigger: SlotComponent;
  /** The menu with its items; renders only while open. Takes `Placement` props. */
  Popup: SlotComponent;
  /** One action; `value` names it in `onAction`, `label` feeds typeahead. */
  Item: SlotComponent;
  Separator: SlotComponent;
  Group: SlotComponent;
  GroupLabel: SlotComponent;
};

/** An action menu: arrows, Home, End, typeahead, Escape and focus return come from core. */
export function useMenu(options: () => OverlayOptions & { onAction?: (value: string) => void } = () => ({})): MenuParts {
  const t = useBehaviorMessages();
  const handle = usePrimitive(menuPrimitive, () => {
    const given = options();
    const onAction = given.onAction;
    return { ...given, pendingAnnouncement: t().loading, onAction: onAction && ((value: unknown) => onAction(String(value))) };
  });
  return {
    Trigger: slotComponent(handle, "trigger", "button"),
    Popup: popupComponent(handle, "content"),
    Item: slotComponent(handle, "item", "div"),
    Separator: slotComponent(handle, "separator", "div"),
    Group: slotComponent(handle, "group", "div"),
    GroupLabel: slotComponent(handle, "group-label", "div"),
  };
}

export type PopoverParts = {
  Trigger: SlotComponent;
  /** The popover; renders only while open. Takes `Placement` props. */
  Popup: SlotComponent;
  Title: SlotComponent;
  Close: SlotComponent;
};

/** A non-modal popover next to its trigger; Escape and an outside press close it. */
export function usePopover(options: () => OverlayOptions = () => ({})): PopoverParts {
  const handle = usePrimitive(popoverPrimitive, options);
  return {
    Trigger: slotComponent(handle, "trigger", "button"),
    Popup: popupComponent(handle, "content"),
    Title: slotComponent(handle, "title", "h2"),
    Close: slotComponent(handle, "close", "button"),
  };
}
