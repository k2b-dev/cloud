import { createEffect, createSignal, type JSX, onCleanup, untrack } from "solid-js";
import { usePopover } from "./behavior/overlays";
import { Icon } from "./marks";
import { EntryFace, edgeRoom, type MenuPanel, type MenuPanelEntryProps } from "./menu";
import { useOverlayMessages } from "./overlay-messages";
import { usePhone } from "./overlays";
import { PageLayer } from "./page-layer";

// A menu entry that opens a panel (a calendar) as its next step. It lives here, not in `menu.tsx`, so a menu without a
// panel loads none of its code: the app brings it with `menuPanel`.

/**
 * An entry that opens a panel (a calendar) as the next step: a menu item, so the menu's keys reach it, that is also
 * the trigger of its own popover. The popover is a dialog of its own at the end of the page, a layer over the menu:
 * the menu never sees its keys (the arrows stay with the calendar), a press inside it is no press outside the menu.
 * On a wide screen it takes the place of the menu the entry stands in (at most two layers show); on the phone it is a
 * sheet of its own. Its head, Escape and the back button lead back to the entry. Enter, Space and the arrow to the side
 * open it, as they open a submenu; it stays open while the menu's data changes (a clock that moved on keeps what was
 * typed in it).
 */
const MenuPanelEntry = (props: MenuPanelEntryProps) => {
  const t = useOverlayMessages();
  const phone = usePhone();
  const [open, setOpenState] = createSignal(false);
  const [entry, setEntry] = createSignal<HTMLElement>();
  // Where the panel stands on a wide screen: on the corner of its menu that the menu grew from, taken once when it
  // opens (before the menu gives way). It grows the way the menu grew: to the left for a submenu that opened to the
  // left or a menu at the right edge of its button (the end in left-to-right, the start in right-to-left), to the right
  // for every other one, also a context menu at the pointer or a menu turned upwards.
  const [place, setPlace] = createSignal<{ x: number; top: number; growLeft: boolean; rtl: boolean }>();
  // Closing gives the menu its place back at once, before the focus returns to the entry in it (a hidden entry takes
  // no focus); the focus then stands on the entry unless something else took it.
  const setOpen = (next: boolean) => {
    if (next && !open()) {
      const menu = entry()?.closest<HTMLElement>(".k2-menu");
      if (menu) {
        const box = menu.getBoundingClientRect();
        const side = menu.getAttribute("data-side");
        // the menu and the panel's layer at the end of the page both take the page's direction (<html dir>), so the
        // menu's says how core reads the panel's start and end too
        const rtl = getComputedStyle(menu).direction === "rtl";
        // a submenu's side is physical; a menu under or over its button lines up with its start or end, which the
        // page's direction turns into left or right
        const growLeft = side === "left" || (side !== "right" && (menu.getAttribute("data-align") === "end") !== rtl);
        setPlace({ x: growLeft ? box.right : box.left, top: box.top, growLeft, rtl });
      } else setPlace(undefined);
    }
    if (!next && open()) {
      entry()?.closest(".k2-menu")?.removeAttribute("data-covered");
      requestAnimationFrame(() => {
        const at = document.activeElement;
        if (!at || at === document.body) entry()?.focus();
      });
    }
    setOpenState(next);
  };
  const popover = usePopover(() => ({ open: open(), onOpenChange: setOpen, modal: true, presentation: phone() ? "sheet" : "popover" }));
  createEffect(() => {
    const element = entry();
    if (!element) return;
    // a disabled entry stays shut, to a press and to the keys
    const disabled = !!props.item.disabled;
    onCleanup(popover.bindTrigger(element, { disabled }));
    // the menu's Enter would choose the entry and its arrow to the side does nothing here: both open the panel
    const keys = (event: KeyboardEvent) => {
      if (disabled || (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowRight")) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(true);
    };
    element.addEventListener("keydown", keys);
    onCleanup(() => element.removeEventListener("keydown", keys));
  });
  // The panel takes the focus once it shows (a sheet shows a moment after it opens, and WebKit leaves the focus of a
  // tap in the menu): keys, Escape first of all, then reach the panel, not the menu behind it.
  let panel: HTMLElement | undefined;
  createEffect(() => {
    if (!open()) return;
    let frame = 0;
    let tries = 0;
    const take = () => {
      const shown = panel?.isConnected && !panel.hidden && panel.getClientRects().length > 0;
      if (!shown) {
        tries += 1;
        if (tries < 120) frame = requestAnimationFrame(take);
        return;
      }
      if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    };
    frame = requestAnimationFrame(take);
    // An Escape that still lands in the menu behind (the menu's sheet keeps the focus in WebKit) closes the panel
    // only, as the innermost layer, and puts the focus back on its entry. Only that menu: a menu inside the panel is a
    // layer above it and closes by itself.
    const escape = (event: KeyboardEvent) => {
      const behind = entry()?.closest('[role="menu"]');
      if (event.key !== "Escape" || !behind || document.activeElement?.closest('[role="menu"]') !== behind) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
      entry()?.focus();
    };
    document.addEventListener("keydown", escape, true);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", escape, true);
    });
  });
  // On a wide screen the panel takes the place of the menu its entry stands in (at most two layers show): that menu
  // gives way while the panel is open, and the panel stands where it stood. The panel's head leads back to it.
  const holder = () => entry()?.closest<HTMLElement>(".k2-menu") ?? undefined;
  createEffect(() => {
    const menu = holder();
    if (!open() || phone() || !menu) return;
    menu.setAttribute("data-covered", "");
    onCleanup(() => menu.removeAttribute("data-covered"));
  });
  const corner = () => (phone() ? undefined : place());
  /** The edge of the panel that stands on the corner, in the reading direction that core places by. */
  const panelAlign = () => {
    const at = corner();
    return at && at.growLeft !== at.rtl ? "end" : "start";
  };
  const close = () => {
    setOpen(false);
    props.level.close();
  };
  return (
    <>
      <props.level.Item {...props.keyed} ref={setEntry} closeOnSelect={false}>
        <EntryFace item={props.item} lead={props.lead} end={<Icon name="chevron-right" />} />
      </props.level.Item>
      <PageLayer from={entry}>
        <popover.Popup
          ref={(element: HTMLElement) => {
            panel = element;
          }}
          class="k2-pop k2-dpop"
          data-k2-part="Popover"
          aria-label={props.item.label}
          {...(() => {
            const at = corner();
            if (!at) return {};
            // The corner is taken once, when the panel opens. Read on every check, its height keeps the panel inside
            // the window: in a short one it moves up, never past the top (taller than the window, it scrolls inside).
            const anchor = {
              getBoundingClientRect: () => {
                const tall = panel?.offsetHeight ?? 0;
                return new DOMRect(at.x, Math.max(edgeRoom, Math.min(at.top, window.innerHeight - tall - edgeRoom)), 0, 0);
              },
            };
            return { anchor };
          })()}
          side="bottom"
          // the edge of the panel that stands on the corner, in the reading direction core places by
          align={panelAlign()}
          sideOffset={corner() ? 0 : 4}
          collisionPadding={edgeRoom}
        >
          {/* the panel names its step and leads back to the entries it took the place of, as a submenu's step does */}
          <button
            type="button"
            class="k2-mi k2-panel-back"
            aria-label={t().backTo({ name: props.item.label })}
            onClick={() => {
              setOpen(false);
              entry()?.focus();
            }}
          >
            <Icon name="chevron-left" />
            <span class="k2-mi-label">{props.item.label}</span>
          </button>
          {/* made once while open: new data for the menu keeps what was typed in the panel */}
          {untrack(() => props.item.panel?.content(close))}
        </popover.Popup>
      </PageLayer>
    </>
  );
};

/**
 * A panel for a menu entry, such as a `DatePicker`: `{ label: "Datum und Uhrzeit …", panel: menuPanel((close) =>
 * <DatePicker … onChange={(value) => { pick(value); close(); }} />) }`. The content is made once while it is open.
 */
export const menuPanel = (content: (close: () => void) => JSX.Element): MenuPanel => ({ content, Entry: MenuPanelEntry });
