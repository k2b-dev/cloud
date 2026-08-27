import { createMemo, createSignal, createUniqueId, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { useUiMessages } from "../intl/messages";
import { type DropdownItem, DropdownItems, type DropdownPosition, dropdownPosition } from "./Dropdown";

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
};

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
  const messages = useUiMessages();
  const generatedId = `k2b-context-${createUniqueId()}`;
  const menuId = `${generatedId}-menu`;
  const [position, setPosition] = createSignal<{ x: number; y: number }>();
  let host: HTMLDivElement | undefined;
  let menu: HTMLDivElement | undefined;
  let listenersAttached = false;

  const isOpen = () => position() !== undefined;
  const hostClass = createMemo(() => (typeof props.class === "function" ? props.class(isOpen()) : props.class));
  const items = createMemo<readonly DropdownItem[]>(() => props.items);

  const dismiss = (event: PointerEvent) => {
    if (menu?.contains(event.target as Node)) return;
    close();
  };
  const closeOnViewportChange = (event: Event) => {
    const target = event.target;
    if (target instanceof Node && menu?.contains(target)) return;
    close();
  };
  const attachOpenListeners = () => {
    if (listenersAttached) return;
    listenersAttached = true;
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keyDown);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
  };
  const detachOpenListeners = () => {
    if (!listenersAttached) return;
    listenersAttached = false;
    document.removeEventListener("pointerdown", dismiss);
    document.removeEventListener("keydown", keyDown);
    window.removeEventListener("resize", closeOnViewportChange);
    window.removeEventListener("scroll", closeOnViewportChange, true);
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
    const point = dropdownPosition(
      new DOMRect(x, y, 0, 0),
      // Matches the fixed 13rem `.k2b-context-menu` surface (border-box).
      { width: 208, height: Math.min(items().length * 38 + 12, 384) },
      "bottom-right" satisfies DropdownPosition,
      { width: window.innerWidth, height: window.innerHeight },
      0,
    );
    setPosition({ x: point.left, y: point.top });
    closeActiveContextMenu = close;
    attachOpenListeners();
    props.onOpen?.();
    queueMicrotask(() => {
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
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusItem(event.key === "Home" ? 0 : -1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
      host?.focus();
    } else if (event.key === "Tab") {
      close();
    }
  };

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
          event.preventDefault();
          event.stopPropagation();
          open(event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (props.disabled || (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))) return;
          event.preventDefault();
          const rect = host?.getBoundingClientRect();
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
              <DropdownItems items={items()} close={close} />
            </div>
          </Portal>
        )}
      </Show>
    </>
  );
}

export default ContextMenu;
