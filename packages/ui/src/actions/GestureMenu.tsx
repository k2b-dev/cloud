import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { dialogCore } from "../feedback/dialog-core";
import { LocaleProvider, useLocale } from "../intl/locale";
import BottomSheet, { bottomSheetOptions } from "../layout/BottomSheet";
import { ContextMenu } from "./ContextMenu";
import {
  type DropdownAction,
  type DropdownActionBase,
  type DropdownChoice,
  DropdownItems,
  type DropdownSection,
  focusRowSegment,
} from "./Dropdown";

/** A finger held this long without moving opens the menu, as the platforms' own long press does. */
const LONG_PRESS_MS = 500;
/** A second tap that starts this soon after the first ended makes a double tap. */
const DOUBLE_TAP_MS = 300;
/** The second tap lands at most this far from the first. */
const DOUBLE_TAP_DISTANCE = 32;
/** Movement up to this is still a tap or a long press. */
const SLOP = 10;
/** A swipe must be this many times wider than tall; anything steeper belongs to the page's scrolling. */
const SWIPE_RATIO = 1.5;
/** Travel at which a released swipe runs its action. */
const SWIPE_THRESHOLD = 64;
/** The content follows the finger up to the threshold, then at a quarter of its travel, up to this. */
const SWIPE_MAX = 96;
const SWIPE_RESISTANCE = 0.25;
/** Swipes do not start this close to the screen's side edges, where the system's back and forward gestures are. */
const EDGE = 20;
/** Duration of the snap back in `.k2b-gesture-menu[data-settling]`. */
const SETTLE_MS = 160;

/**
 * Gestures never start on these elements: links, controls, fields, code blocks, and anything marked
 * `data-gesture-ignore` keep their own touch and mouse behavior.
 */
const IGNORE = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  "label",
  "audio",
  "video",
  "pre",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='switch']",
  "[role='slider']",
  "[role='tab']",
  "[role^='menuitem']",
  "[data-gesture-ignore]",
].join(", ");

export type GestureKind = "swipe-right" | "swipe-left" | "double-tap";

/** A menu action that a gesture runs as well. */
export type GestureMenuAction = DropdownActionBase & {
  action: () => void;
  /** The gesture that runs this action. Give each gesture to at most one item; a disabled item disables its gesture. */
  gesture?: GestureKind;
};

export type GestureMenuSection = Omit<DropdownSection, "items"> & {
  items: readonly (GestureMenuAction | DropdownAction | DropdownChoice)[];
};

export type GestureMenuItem = GestureMenuAction | DropdownAction | DropdownChoice | GestureMenuSection;

export type GestureMenuProps = {
  /**
   * The menu. A long press opens it as a bottom sheet, a right-click, the Context Menu key, or Shift+F10 as a menu.
   * An item with `gesture` is also run by that gesture, so every gesture has its entry here.
   */
  items: readonly GestureMenuItem[];
  /** Names the element and its menu, for example "Message from Nora, 10:42". */
  label: string;
  children: JSX.Element;
  /** Shown above the menu in the long-press sheet, for example a row of quick reactions. `close` closes the sheet. */
  sheetTop?: (close: () => void) => JSX.Element;
  /** Tab order of the element. A list that moves focus between its rows itself passes -1. */
  tabIndex?: number;
  class?: string;
};

type SwipeDirection = "right" | "left";

type Swipe = {
  direction: SwipeDirection;
  icon?: string;
  /** How far the content is moved, in pixels; always 0 with reduced motion. */
  offset: number;
  /** Travel relative to the threshold, from 0 to 1. */
  progress: number;
  armed: boolean;
  settling: boolean;
};

type Press = {
  id: number;
  x: number;
  y: number;
  timer?: ReturnType<typeof setTimeout>;
  /** The finger left the slop: no tap or long press any more. */
  moved: boolean;
  /** The long press opened the sheet. */
  long: boolean;
  /** The press started soon after a tap nearby. */
  second: boolean;
  /** The press started at a side edge of the screen. */
  edge: boolean;
  direction?: SwipeDirection;
};

type Entry = GestureMenuAction | DropdownAction | DropdownChoice;

const gestureAction = (items: readonly GestureMenuItem[], kind: GestureKind): GestureMenuAction | undefined => {
  for (const item of items)
    for (const entry of "items" in item ? item.items : [item])
      if ("gesture" in entry && entry.gesture === kind) return entry.disabled ? undefined : entry;
  return undefined;
};

const swipeKind = (direction: SwipeDirection): GestureKind => (direction === "right" ? "swipe-right" : "swipe-left");

/**
 * The sheet's items hand their action to `run` instead of running it while the sheet closes: `dialogCore` settles the
 * sheet after it left the history, and only then may an action navigate or open the next dialog. A choice that keeps
 * the menu open runs at once.
 */
const afterClose = (items: readonly GestureMenuItem[], run: (action: () => void) => void): GestureMenuItem[] => {
  const entry = (item: Entry): Entry => {
    const action = item.action;
    if (!action || ("choice" in item && item.closeOnSelect === false)) return item;
    return { ...item, action: () => run(action) };
  };
  return items.map((item) => ("items" in item ? { ...item, items: item.items.map(entry) } : entry(item)));
};

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const menuItems = (menu: HTMLElement): HTMLElement[] =>
  Array.from(menu.querySelectorAll<HTMLElement>("[role^='menuitem']:not([aria-disabled='true'])"));

/**
 * The menu inside the long-press sheet: the same items, at touch size, with arrow keys for a connected keyboard. Focus
 * starts on the sheet itself, which shows no ring on a phone; the first arrow key moves it into the menu.
 */
function SheetMenu(props: { items: readonly GestureMenuItem[]; label: string; close: () => void; dialog: HTMLDialogElement }): JSX.Element {
  let menu!: HTMLDivElement;
  const focus = (index: number) => {
    const items = menuItems(menu);
    items[(index + items.length) % items.length]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const items = menuItems(menu);
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") focus(current + 1);
    else if (event.key === "ArrowUp") focus(current < 0 ? -1 : current - 1);
    else if (event.key === "Home" || event.key === "End") focus(event.key === "Home" ? 0 : -1);
    else if (!focusRowSegment(items, event.key)) return;
    event.preventDefault();
  };
  // Keys pressed on the sheet itself, while it is the top level of the shared dialog.
  const onSheetKeyDown = (event: KeyboardEvent) => {
    if (event.target === props.dialog && props.dialog.lastElementChild?.contains(menu)) onKeyDown(event);
  };
  onMount(() => {
    props.dialog.addEventListener("keydown", onSheetKeyDown);
    onCleanup(() => props.dialog.removeEventListener("keydown", onSheetKeyDown));
  });
  return (
    <div ref={menu} class="k2b-gesture-menu__sheet-menu" role="menu" aria-label={props.label} onKeyDown={onKeyDown}>
      <DropdownItems items={props.items} close={() => props.close()} />
    </div>
  );
}

/**
 * Touch gestures for an element, each the shortcut of an entry in its menu: a horizontal swipe, a double tap, and a
 * long press that opens the whole menu as a `BottomSheet`. A mouse double-click runs the double-tap action; a
 * right-click and the keyboard open the menu beside the element. Vertical scrolling never turns into a swipe.
 */
export function GestureMenu(props: GestureMenuProps): JSX.Element {
  const locale = useLocale();
  const [swipe, setSwipe] = createSignal<Swipe>();
  let surface!: HTMLDivElement;
  let press: Press | undefined;
  let lastTap: { x: number; y: number; at: number } | undefined;
  let lastPointer = "mouse";
  /**
   * The touch or pen press that just ended did something: its `touchend` is cancelled, so no click or mouse events
   * follow, and a pen's click, which comes without touch events, is cancelled itself.
   */
  let consumed = false;
  let sheetOpen = false;
  /** Closes an open sheet when the element goes, for example when its message is deleted. */
  const disposed = new AbortController();
  let reduced = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const active = () => props.items.length > 0;
  const action = (kind: GestureKind) => gestureAction(props.items, kind);
  const touchAction = () => (action("swipe-right") || action("swipe-left") ? "swipe" : action("double-tap") ? "tap" : undefined);

  /** Whether the event started on something with a meaning of its own, inside this element. */
  const ignored = (target: EventTarget | null) => {
    const found = target instanceof Element ? target.closest(IGNORE) : null;
    return found !== null && found !== surface && surface.contains(found);
  };

  const openSheet = () => {
    if (sheetOpen || !active()) return;
    sheetOpen = true;
    const current = locale();
    let chosen: (() => void) | undefined;
    const choose = (action: () => void) => {
      chosen = action;
    };
    void dialogCore
      .open<void>(
        (close, context) => (
          <LocaleProvider locale={current}>
            <BottomSheet onDismiss={context.requestDismiss}>
              <BottomSheet.Body>
                {props.sheetTop?.(() => close())}
                <SheetMenu items={afterClose(props.items, choose)} label={props.label} close={() => close()} dialog={context.dialog} />
              </BottomSheet.Body>
            </BottomSheet>
          </LocaleProvider>
        ),
        { ...bottomSheetOptions, ariaLabel: props.label, history: true, signal: disposed.signal },
      )
      .then(() => chosen?.())
      .finally(() => {
        sheetOpen = false;
      });
  };

  /** Another pointer that goes down anywhere while a finger presses, as in a pinch, ends the gesture. */
  const onOtherPointer = (event: PointerEvent) => {
    if (!press || event.pointerId === press.id) return;
    if (press.direction) settle();
    endPress();
  };

  const endPress = () => {
    clearTimeout(press?.timer);
    press = undefined;
    document.removeEventListener("pointerdown", onOtherPointer, true);
    delete surface.dataset.pressing;
  };

  const settle = () => {
    const current = swipe();
    if (!current) return;
    clearTimeout(settleTimer);
    if (reduced || current.offset === 0) {
      setSwipe(undefined);
      return;
    }
    setSwipe({ ...current, offset: 0, progress: 0, armed: false, settling: true });
    settleTimer = setTimeout(() => setSwipe(undefined), SETTLE_MS);
  };

  const moveSwipe = (current: Press, direction: SwipeDirection, dx: number) => {
    const travel = Math.max(0, direction === "right" ? dx : -dx);
    const moved = travel <= SWIPE_THRESHOLD ? travel : SWIPE_THRESHOLD + (travel - SWIPE_THRESHOLD) * SWIPE_RESISTANCE;
    const offset = reduced ? 0 : Math.min(SWIPE_MAX, moved) * (direction === "right" ? 1 : -1);
    current.direction = direction;
    setSwipe({
      direction,
      icon: action(swipeKind(direction))?.icon,
      offset,
      progress: Math.min(1, travel / SWIPE_THRESHOLD),
      armed: travel >= SWIPE_THRESHOLD,
      settling: false,
    });
  };

  const longPress = () => {
    if (!press) return;
    press.long = true;
    lastTap = undefined;
    openSheet();
  };

  const onPointerDown = (event: PointerEvent) => {
    lastPointer = event.pointerType;
    consumed = false;
    // Any press in between, on a link, with a mouse, or with another finger, ends a pending double tap.
    const previous = lastTap;
    lastTap = undefined;
    // Another finger ends the gesture through `onOtherPointer` and starts none.
    if (event.pointerType === "mouse" || !event.isPrimary) return;
    endPress();
    if (!active() || ignored(event.target)) return;
    const second =
      previous !== undefined &&
      performance.now() - previous.at <= DOUBLE_TAP_MS &&
      Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= DOUBLE_TAP_DISTANCE;
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      long: false,
      second,
      edge: event.clientX < EDGE || event.clientX > window.innerWidth - EDGE,
      timer: setTimeout(longPress, LONG_PRESS_MS),
    };
    document.addEventListener("pointerdown", onOtherPointer, true);
    // Hybrid devices keep text selection for the mouse; a finger on the element selects nothing.
    surface.dataset.pressing = "";
  };

  const onPointerMove = (event: PointerEvent) => {
    const current = press;
    if (!current || event.pointerId !== current.id || current.long) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (current.direction) {
      moveSwipe(current, current.direction, dx);
      return;
    }
    if (current.moved || Math.hypot(dx, dy) < SLOP) return;
    current.moved = true;
    clearTimeout(current.timer);
    if (current.edge || Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return;
    const direction: SwipeDirection = dx > 0 ? "right" : "left";
    if (!action(swipeKind(direction))) return;
    clearTimeout(settleTimer);
    reduced = reducedMotion();
    moveSwipe(current, direction, dx);
  };

  const onPointerUp = (event: PointerEvent) => {
    const current = press;
    if (!current || event.pointerId !== current.id) return;
    endPress();
    if (current.long) {
      consumed = true;
      return;
    }
    if (current.direction) {
      // Where the finger lifts decides, and the item as it is now.
      moveSwipe(current, current.direction, event.clientX - current.x);
      const swipeAction = swipe()?.armed ? action(swipeKind(current.direction)) : undefined;
      settle();
      if (swipeAction) {
        consumed = true;
        swipeAction.action();
      }
      return;
    }
    if (current.moved) return;
    const doubleTap = action("double-tap");
    if (!doubleTap) return;
    if (current.second) {
      consumed = true;
      doubleTap.action();
      return;
    }
    lastTap = { x: event.clientX, y: event.clientY, at: performance.now() };
  };

  // The browser took the touch, for example to scroll the page.
  const onPointerCancel = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.id) return;
    if (press.direction) settle();
    endPress();
    lastTap = undefined;
  };

  const onTouchEnd = (event: TouchEvent) => {
    if (!consumed) return;
    consumed = false;
    if (event.cancelable) event.preventDefault();
  };

  // A pen sends no touch events; the click after its gesture is cancelled here. A keyboard's click has no detail.
  const onClick = (event: MouseEvent) => {
    if (!consumed || event.detail === 0) return;
    consumed = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const onContextMenu = (event: MouseEvent) => {
    // Without items the element has no menu, and the browser keeps its own.
    if (!active()) return;
    // Links, fields, and code keep the browser's own menu.
    if (ignored(event.target)) {
      event.stopPropagation();
      return;
    }
    // A mouse or the keyboard opens the menu beside the element through ContextMenu.
    if (!press && !("pointerType" in event && (event.pointerType === "touch" || event.pointerType === "pen"))) return;
    // Android and touch screens report a long press as a context-menu event, sometimes before the timer.
    event.preventDefault();
    event.stopPropagation();
    if (press && !press.long && !press.moved) {
      clearTimeout(press.timer);
      longPress();
    }
  };

  // The second press of a mouse double-click would select a word; in this element it runs the double-tap action.
  const onMouseDown = (event: MouseEvent) => {
    if (event.button === 0 && event.detail >= 2 && lastPointer === "mouse" && action("double-tap") && !ignored(event.target))
      event.preventDefault();
  };

  const onDoubleClick = (event: MouseEvent) => {
    if (lastPointer !== "mouse" || ignored(event.target)) return;
    const doubleTap = action("double-tap");
    if (!doubleTap) return;
    event.preventDefault();
    doubleTap.action();
  };

  onMount(() => {
    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("pointermove", onPointerMove);
    surface.addEventListener("pointerup", onPointerUp);
    surface.addEventListener("pointercancel", onPointerCancel);
    surface.addEventListener("touchend", onTouchEnd, { passive: false });
    surface.addEventListener("click", onClick, true);
    surface.addEventListener("contextmenu", onContextMenu);
    surface.addEventListener("mousedown", onMouseDown);
    surface.addEventListener("dblclick", onDoubleClick);
    onCleanup(() => {
      disposed.abort();
      endPress();
      clearTimeout(settleTimer);
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", onPointerUp);
      surface.removeEventListener("pointercancel", onPointerCancel);
      surface.removeEventListener("touchend", onTouchEnd);
      surface.removeEventListener("click", onClick, true);
      surface.removeEventListener("contextmenu", onContextMenu);
      surface.removeEventListener("mousedown", onMouseDown);
      surface.removeEventListener("dblclick", onDoubleClick);
    });
  });

  return (
    <ContextMenu items={props.items} label={props.label} tabIndex={props.tabIndex} disabled={!active()} class={props.class}>
      <div
        ref={surface}
        class="k2b-gesture-menu"
        data-active={active() ? "" : undefined}
        data-touch={touchAction()}
        data-swipe={swipe()?.direction}
        data-armed={swipe()?.armed ? "" : undefined}
        data-settling={swipe()?.settling ? "" : undefined}
        style={{
          "--k2b-gesture-menu-offset": `${swipe()?.offset ?? 0}px`,
          "--k2b-gesture-menu-progress": String(swipe()?.progress ?? 0),
        }}
      >
        <Show when={swipe()}>
          {(current) => (
            <span class="k2b-gesture-menu__swipe" aria-hidden="true">
              <i class={current().icon ?? (current().direction === "right" ? "ti ti-arrow-right" : "ti ti-arrow-left")} />
            </span>
          )}
        </Show>
        <div class="k2b-gesture-menu__content">{props.children}</div>
      </div>
    </ContextMenu>
  );
}

export default GestureMenu;
