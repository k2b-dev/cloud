import { createEffect, createSignal, type JSX, onCleanup, Show, untrack } from "solid-js";
import { usePopover } from "./behavior/overlays";
import { Icon } from "./marks";
import { EntryFace, type MenuPanel, type MenuPanelEntryProps } from "./menu";
import { useOverlayMessages } from "./overlay-messages";
import { usePhone } from "./overlays";
import { PageLayer } from "./page-layer";

// A menu entry that opens a panel (a calendar) beside it. It lives here, not in `menu.tsx`, so a menu without a panel
// loads none of its code: the app brings it with `menuPanel`.

/**
 * An entry that opens a panel (a calendar) beside it: a menu item, so the menu's keys reach it, that is also the
 * trigger of its own popover. The popover is a dialog of its own at the end of the page, a layer over the menu: the
 * menu never sees its keys, a press inside it is no press outside the menu, Escape closes it first and puts the focus
 * back on the entry. Enter, Space and the arrow to the side open it, as they open a submenu; it stays open while the
 * menu's data changes (a clock that moved on keeps what was typed in it). On the phone it is a sheet of its own.
 */
const MenuPanelEntry = (props: MenuPanelEntryProps) => {
  const t = useOverlayMessages();
  const phone = usePhone();
  const [open, setOpen] = createSignal(false);
  const popover = usePopover(() => ({ open: open(), onOpenChange: setOpen, modal: true, presentation: phone() ? "sheet" : "popover" }));
  const [entry, setEntry] = createSignal<HTMLElement>();
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
  // beside the entry on the side its menu opened to, so it never covers the way it came
  const side = () => (entry()?.closest(".k2-menu")?.getAttribute("data-side") === "left" ? "left" : "right");
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
          side={side()}
          align="start"
          sideOffset={4}
          collisionPadding={8}
        >
          {/* on the phone the sheet names its step and leads back to the entries, as a submenu's step does */}
          <Show when={phone()}>
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
          </Show>
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
