import { createMemo, createSignal, createUniqueId, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { returnFocus, ringOnReturn } from "../internal/focus-return";
import { useUiMessages } from "../intl/messages";
import { type DropdownItem, DropdownItems, type DropdownPosition, dropdownPosition } from "./Dropdown";
import { focusRowSegment } from "./menu-rows";

export type ContextMenuProps = {
  items: readonly DropdownItem[];
  children: JSX.Element;
  class?: string | ((isOpen: boolean) => string);
  /** Tab order of the context-menu host. Descendant-focused composite widgets use -1. */
  tabIndex?: number;
  disabled?: boolean;
  onClose?: () => void;
  onOpen?: () => void;
  id?: string;
  label?: string;
  /**
   * Links, form fields, editable text, and selected text inside the host keep the browser's own menu, with its Copy,
   * Paste, and Open link. Use it where the host wraps readable content rather than one row.
   */
  keepNativeMenu?: boolean;
};

const NATIVE_MENU_TARGETS = "a[href], input, textarea, select, [contenteditable]:not([contenteditable='false'])";

let closeActiveContextMenu: (() => void) | undefined;

const focusableItems = (menu: HTMLElement | undefined): HTMLElement[] =>
  menu
    ? Array.from(
        menu.querySelectorAll<HTMLElement>(
          [
            "[role='menuitem']:not([aria-disabled='true'])",
            "[role='menuitemcheckbox']:not([aria-disabled='true'])",
            "[role='menuitemradio']:not([aria-disabled='true'])",
          ].join(", "),
        ),
      )
    : [];

/** Right-click menu with keyboard invocation, one-open-at-a-time behavior, and viewport clamping. */
export function ContextMenu(props: ContextMenuProps): JSX.Element {
  return ContextMenuBase(props);
}

/**
 * Package-internal, not exported from the package index: `openAt` lets GestureMenu open the menu at a held finger, and
 * `title` names what was pressed above the entries, since the finger covers it.
 */
export function ContextMenuBase(
  props: ContextMenuProps & {
    openAt?: (open: (x: number, y: number) => void) => void;
    title?: string;
    closeWith?: (close: () => void) => void;
  },
): JSX.Element {
  const messages = useUiMessages();
  const generatedId = `k2b-context-${createUniqueId()}`;
  const menuId = `${generatedId}-menu`;
  const [position, setPosition] = createSignal<{ x: number; y: number }>();
  let host: HTMLDivElement | undefined;
  let menu: HTMLDivElement | undefined;
  let listenersAttached = false;
  let hostRing = true;
  /** The element inside the host that had focus as the menu opened, such as a row or a day of a composite widget. */
  let opener: HTMLElement | undefined;
  let anchor = { x: 0, y: 0 };
  let viewport = { width: 0, height: 0 };
  let resizeObserver: ResizeObserver | undefined;

  const isOpen = () => position() !== undefined;
  const keepsNativeMenu = (target: EventTarget | null): boolean => {
    if (!props.keepNativeMenu || !(target instanceof Node)) return false;
    const element = target instanceof Element ? target : target.parentElement;
    const native = element?.closest(NATIVE_MENU_TARGETS);
    if (native && host?.contains(native)) return true;
    const selection = window.getSelection();
    return Boolean(selection && !selection.isCollapsed && selection.toString().trim() && selection.containsNode(target, true));
  };
  const hostClass = createMemo(() => (typeof props.class === "function" ? props.class(isOpen()) : props.class));
  const items = createMemo<readonly DropdownItem[]>(() => props.items);

  const dismiss = (event: PointerEvent) => {
    if (menu?.contains(event.target as Node)) return;
    close();
  };
  const closeOnScroll = (event: Event) => {
    const target = event.target;
    if (target instanceof Node && menu?.contains(target)) return;
    close();
  };
  // A resize event may leave the viewport's size unchanged; headless Chromium
  // was seen to fire one on a fresh page. The clamped menu is still in place.
  const closeOnResize = () => {
    if (window.innerWidth === viewport.width && window.innerHeight === viewport.height) return;
    close();
  };
  const attachOpenListeners = () => {
    if (listenersAttached) return;
    listenersAttached = true;
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keyDown);
    window.addEventListener("resize", closeOnResize);
    window.addEventListener("scroll", closeOnScroll, true);
  };
  const detachOpenListeners = () => {
    if (!listenersAttached) return;
    listenersAttached = false;
    document.removeEventListener("pointerdown", dismiss);
    document.removeEventListener("keydown", keyDown);
    window.removeEventListener("resize", closeOnResize);
    window.removeEventListener("scroll", closeOnScroll, true);
    resizeObserver?.disconnect();
  };
  /** Clamps the rendered menu into the viewport beside the point that opened it. */
  const place = () => {
    if (!isOpen() || !menu?.isConnected) return;
    const point = dropdownPosition(
      new DOMRect(anchor.x, anchor.y, 0, 0),
      menu.getBoundingClientRect(),
      "bottom-right" satisfies DropdownPosition,
      { width: window.innerWidth, height: window.innerHeight },
      0,
    );
    setPosition({ x: point.left, y: point.top });
  };
  const close = () => {
    detachOpenListeners();
    if (!isOpen()) return;
    setPosition();
    if (closeActiveContextMenu === close) closeActiveContextMenu = undefined;
    props.onClose?.();
  };
  const focusItem = (index: number) => {
    const items = focusableItems(menu);
    if (items.length === 0) return;
    items[(index + items.length) % items.length]?.focus();
  };
  const open = (x: number, y: number) => {
    if (props.disabled) return;
    closeActiveContextMenu?.();
    // Focus may sit on a descendant of the host, as in composite widgets; Escape returns it there.
    const focused = document.activeElement;
    opener = focused instanceof HTMLElement && focused !== host && host?.contains(focused) ? focused : undefined;
    hostRing = ringOnReturn(focused);
    anchor = { x, y };
    viewport = { width: window.innerWidth, height: window.innerHeight };
    setPosition({ x, y });
    closeActiveContextMenu = close;
    attachOpenListeners();
    props.onOpen?.();
    // The menu sizes to its entries, so it is measured once rendered and
    // clamped into the viewport before the next paint, and again whenever its
    // entries change its size while it is open.
    queueMicrotask(() => {
      if (!isOpen() || !menu?.isConnected) return;
      place();
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver ??= new ResizeObserver(place);
        resizeObserver.observe(menu);
      }
      focusItem(0);
    });
  };
  const keyDown = (event: KeyboardEvent) => {
    if (!isOpen()) return;
    const items = focusableItems(menu);
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(current + (event.key === "ArrowDown" ? 1 : -1));
    } else if (focusRowSegment(items, event.key)) {
      event.preventDefault();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusItem(event.key === "Home" ? 0 : -1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
      returnFocus(opener?.isConnected ? opener : host, hostRing);
    } else if (event.key === "Tab") {
      close();
    }
  };

  props.openAt?.(open);
  // A close from outside, such as a drag taking over the press, returns focus that sits in the menu to where it came from.
  props.closeWith?.(() => {
    if (isOpen() && menu?.contains(document.activeElement)) returnFocus(opener?.isConnected ? opener : host, hostRing);
    close();
  });

  onMount(() => {
    onCleanup(() => {
      detachOpenListeners();
      if (closeActiveContextMenu === close) closeActiveContextMenu = undefined;
    });
  });

  return (
    <>
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the named group owns the context-menu relationship without pretending arbitrary children form one button. */}
      <div
        ref={host}
        id={props.id ?? generatedId}
        class={hostClass()}
        role="group"
        tabIndex={props.disabled ? undefined : (props.tabIndex ?? 0)}
        aria-label={props.label ?? messages().contextMenu}
        aria-haspopup="menu"
        aria-expanded={isOpen()}
        aria-controls={isOpen() ? menuId : undefined}
        aria-disabled={props.disabled ? "true" : undefined}
        onContextMenu={(event) => {
          if (props.disabled) return;
          // An enclosing context menu must not take over the browser's own either.
          if (keepsNativeMenu(event.target)) return void event.stopPropagation();
          event.preventDefault();
          event.stopPropagation();
          open(event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (props.disabled || (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))) return;
          // A nested context menu already opened its own; a field keeps the browser's.
          if (
            event.defaultPrevented ||
            (props.keepNativeMenu && event.target instanceof Element && event.target.closest(NATIVE_MENU_TARGETS))
          )
            return;
          event.preventDefault();
          // Beside the focused element, such as a row of a composite widget, rather than the corner of the whole host.
          const focused = document.activeElement;
          const rect = (focused instanceof HTMLElement && host?.contains(focused) ? focused : host)?.getBoundingClientRect();
          if (rect) open(rect.left + 12, rect.top + 12);
        }}
      >
        {props.children}
      </div>
      <Show when={position()}>
        {(point) => (
          <Portal>
            <div
              ref={menu}
              id={menuId}
              class="k2b-ui k2b-context-menu"
              role="menu"
              aria-label={props.label ?? messages().contextMenu}
              style={{ left: `${point().x}px`, top: `${point().y}px` }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {/* The menu carries the same name for assistive technology. */}
              <Show when={props.title}>
                <div class="k2b-context-menu__title" aria-hidden="true">
                  {props.title}
                </div>
              </Show>
              <DropdownItems items={items()} close={close} />
            </div>
          </Portal>
        )}
      </Show>
    </>
  );
}

export default ContextMenu;
