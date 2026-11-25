/**
 * Dialog, Menu and Popover behaviour for v2. Focus trap, Escape, focus return, outside press, positioning, roving
 * focus and typeahead are core's. Each `use…` hook makes one instance and returns its parts as components; the v2
 * primitives add structure and look. No ui-sdk type crosses this module's exports.
 */
import { isFocusFromKeyboard } from "@ui-sdk/core";
import { alertDialog as alertDialogPrimitive, createConfirm } from "@ui-sdk/core/alert-dialog";
import { dialog as dialogPrimitive } from "@ui-sdk/core/dialog";
import { drawer as drawerPrimitive } from "@ui-sdk/core/drawer";
import { menu as menuPrimitive } from "@ui-sdk/core/menu";
import { popover as popoverPrimitive } from "@ui-sdk/core/popover";
import { type JSX, onCleanup } from "solid-js";
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

/**
 * Gives the first focus of an overlay to `element` without a focus ring, unless the last thing the person did was a key
 * (a dialog opened with Enter shows where the focus stands). A tap, a click or a page that opens with the dialog shows
 * none, as a button pressed with the pointer shows none; the next key shows the ring. Core then moves the focus to the
 * same element, which changes nothing. `focusVisible` is a hint the browser may ignore; Chromium and WebKit take it.
 */
export const quietFocus = (element: HTMLElement) => {
  if (isFocusFromKeyboard()) return;
  element.focus({ preventScroll: true, focusVisible: false });
};

/** A modal dialog: focus moves in and stays in, Escape and Close close it, focus returns to the trigger. */
export type DialogOptions = OverlayOptions & {
  modal?: boolean;
  presentation?: Presentation;
  /** `false`: Escape, an outside press, a swipe on a sheet and Android's back gesture do not close it; its parts do. */
  dismissible?: boolean;
  /** A refused dismissal and how it was tried: "escape-key", "outside-press", "back" or "swipe". */
  onDismissAttempt?: (reason: string) => void;
};

/**
 * A sheet (a dialog's, or a popover's on the phone) stands on the bottom of the screen. Core answers a change of its
 * content's height with a spring that starts at the old height and moves the whole sheet: for a moment it stands off
 * the bottom, and a tap there hits the backdrop and closes it (#4141). Core offers no way to leave that spring out, so
 * it ends here, before the frame is drawn.
 *
 * Core starts the spring in its own ResizeObserver of the sheet, which may be made before or after this one (its sheet
 * module loads on its own time). So this one only notes the change and observes a part inside the sheet: an
 * observation deeper in the page answers in the next round of the same frame, after every observer of the sheet itself
 * (the ResizeObserver specification's depth rule), and that round ends the spring. The sheet's first height is no change:
 * its opening slides as before.
 */
const holdSheetBottom = (element: HTMLElement) => {
  let height: number | undefined;
  const after = new ResizeObserver(() => {
    after.disconnect();
    for (const animation of element.getAnimations()) animation.finish();
  });
  const sizes = new ResizeObserver(() => {
    const now = element.offsetHeight;
    // hidden (core shows a sheet once its module has loaded) or no sheet: the next height it shows is its first
    if (now === 0 || element.getAttribute("data-presentation") !== "sheet") {
      height = undefined;
      return;
    }
    const changed = height !== undefined && now !== height;
    height = now;
    const inside = [...element.children].find((part) => part.getClientRects().length > 0);
    if (changed && inside) after.observe(inside);
  });
  sizes.observe(element);
  onCleanup(() => {
    sizes.disconnect();
    after.disconnect();
  });
};

export function useDialog(options: () => DialogOptions = () => ({})): DialogParts {
  // An async action in the dialog announces that it is waiting; core's own text is English only.
  const t = useBehaviorMessages();
  const handle = usePrimitive(dialogPrimitive, () => {
    const { onDismissAttempt, ...given } = options();
    return {
      ...given,
      pendingAnnouncement: t().loading,
      onDismissAttempt: onDismissAttempt && ((details: { reason: string }) => onDismissAttempt(details.reason)),
    };
  });
  const Backdrop = popupComponent(handle, "backdrop");
  const Content = popupComponent(handle, "content");
  return {
    Trigger: slotComponent(handle, "trigger", "button"),
    Popup: (props) => (
      <>
        <Backdrop {...(props.backdrop ?? {})} />
        <Content
          {...props}
          ref={(element: HTMLElement) => {
            holdSheetBottom(element);
            props.ref?.(element);
          }}
          backdrop={undefined}
        />
      </>
    ),
    Title: slotComponent(handle, "title", "h2"),
    Description: slotComponent(handle, "description", "p"),
    Close: slotComponent(handle, "close", "button"),
  };
}

export type DrawerParts = Omit<DialogParts, "Description">;

/**
 * A modal panel from an edge of the window: focus moves in and stays in, Escape, a press beside it and a swipe back
 * toward its edge close it, focus returns to the trigger. Core's drawer.
 */
export type DrawerOptions = OverlayOptions & {
  /** The edge it comes from; `"start"` and `"end"` follow the writing direction. */
  side?: "start" | "end" | "top" | "bottom";
};

export function useDrawer(options: () => DrawerOptions = () => ({})): DrawerParts {
  const t = useBehaviorMessages();
  const handle = usePrimitive(drawerPrimitive, () => ({ ...options(), pendingAnnouncement: t().loading }));
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

/**
 * A non-modal popover next to its trigger; Escape and an outside press close it. `presentation: "sheet"` slides it up
 * from the bottom of the screen instead, modal, and a swipe down closes it too.
 */
export function usePopover(options: () => OverlayOptions & { presentation?: "popover" | "sheet" } = () => ({})): PopoverParts {
  const handle = usePrimitive(popoverPrimitive, options);
  const Content = popupComponent(handle, "content");
  return {
    Trigger: slotComponent(handle, "trigger", "button"),
    // as a sheet on the phone it holds its bottom when its content changes height, as a dialog's sheet does
    Popup: (props) => (
      <Content
        {...props}
        ref={(element: HTMLElement) => {
          holdSheetBottom(element);
          props.ref?.(element);
        }}
      />
    ),
    Title: slotComponent(handle, "title", "h2"),
    Close: slotComponent(handle, "close", "button"),
  };
}

export type QuestionParts<Payload> = Omit<DialogParts, "Trigger"> & {
  /** What is asked now; read it while the dialog shows (it renders only while open). */
  payload: () => Payload | undefined;
};

export type Question<Payload> = {
  /** Asks and resolves `true` when the Close part with `value="confirm"` answers, `false` on any other close. */
  ask: (payload: Payload) => Promise<boolean>;
  /** The alert dialog that answers: render it once. Never a sheet; an outside press does not close it. */
  useDialog: () => QuestionParts<Payload>;
};

/**
 * A question any code can ask (`if (await question.ask(…)) …`), answered by one alert dialog rendered elsewhere, one
 * question at a time. Core's `createConfirm`; focus starts on the first Close part, the least destructive answer.
 */
export function createQuestion<Payload>(): Question<Payload> {
  const confirm = createConfirm<Payload>();
  return {
    ask: (payload) => confirm(payload),
    useDialog: () => {
      const t = useBehaviorMessages();
      const handle = usePrimitive(alertDialogPrimitive, () => ({ controller: confirm.controller, pendingAnnouncement: t().loading }));
      const Backdrop = popupComponent(handle, "backdrop");
      const Content = popupComponent(handle, "content");
      return {
        Popup: (props) => (
          <>
            <Backdrop {...(props.backdrop ?? {})} />
            <Content {...props} backdrop={undefined} />
          </>
        ),
        Title: slotComponent(handle, "title", "h2"),
        Description: slotComponent(handle, "description", "p"),
        Close: slotComponent(handle, "close", "button"),
        payload: () => confirm.controller.getPayload(),
      };
    },
  };
}
