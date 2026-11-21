import {
  type Accessor,
  createEffect,
  createRoot,
  createSignal,
  createUniqueId,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
  useContext,
} from "solid-js";
import { inheritUiScope } from "../internal/portal-scope";
import {
  type DropdownAction,
  type DropdownChoice,
  type DropdownItem,
  DropdownItems,
  type DropdownSubmenu,
  itemContent,
  MenuContext,
  type MenuContextValue,
} from "./Dropdown";
import { focusMenuRow, focusRowSegment } from "./menu-rows";

/** How long the pointer rests on a row before its submenu opens, or another row's closes it (K16). */
const DELAY = 150;
/** How long a move towards an open submenu keeps it open while the pointer crosses other rows. */
const CORRIDOR_DELAY = 300;
/** A menu, its submenu, and one more: deeper entries are not offered (K16). */
const MAX_DEPTH = 3;

/** The least room a menu keeps from the viewport's edge, as every menu does. */
const EDGE = 8;
type Box = Pick<DOMRect, "left" | "top" | "right" | "bottom">;

/**
 * Where a submenu stands: beside its row, its first row level with it, on the side that has room; without room on
 * either side it keeps to the viewport. Too low, it rises until its last row is level with its row's bottom.
 */
export const placeSubmenu = (
  row: Box,
  parent: Pick<DOMRect, "left" | "right">,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  rtl = false,
): { left: number; top: number; side: "left" | "right" } => {
  const right = parent.right - 1;
  const left = parent.left - menu.width + 1;
  const fitsRight = right + menu.width <= viewport.width - EDGE;
  const fitsLeft = left >= EDGE;
  const side: "left" | "right" = rtl ? (fitsLeft || !fitsRight ? "left" : "right") : fitsRight || !fitsLeft ? "right" : "left";
  const x = side === "right" ? right : left;
  // The menu's 1 px edge stands above the row, so its first row lines up with the row that opened it.
  let top = row.top - 1;
  if (top + menu.height > viewport.height - EDGE) top = row.bottom + 1 - menu.height;
  return {
    left: Math.max(EDGE, Math.min(x, viewport.width - menu.width - EDGE)),
    top: Math.max(EDGE, Math.min(top, viewport.height - menu.height - EDGE)),
    side,
  };
};

type Point = { x: number; y: number };

const sign = (p: Point, a: Point, b: Point) => (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);

/**
 * Whether `to` lies in the corridor from `from` to the submenu: the triangle between the earlier pointer position and
 * the submenu's near edge. A pointer moving through it is on its way to the submenu.
 */
const inCorridor = (from: Point, to: Point, menu: Box): boolean => {
  const edge = from.x <= menu.left ? menu.left : from.x >= menu.right ? menu.right : undefined;
  if (edge === undefined) return false;
  const top = { x: edge, y: menu.top - EDGE };
  const bottom = { x: edge, y: menu.bottom + EDGE };
  const d1 = sign(to, from, top);
  const d2 = sign(to, top, bottom);
  const d3 = sign(to, bottom, from);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
};

/** The actions and choices of a menu and its submenus, without sections or submenu rows. */
const flatEntries = (items: readonly DropdownItem[]): (DropdownAction | DropdownChoice)[] =>
  items.flatMap((item) => ("items" in item ? flatEntries(item.items) : "submenu" in item ? flatEntries(item.submenu) : [item]));

/** The entries of the submenu `panel` that take focus, without those of a submenu open inside it. */
const ownEntries = (panel: HTMLElement): HTMLElement[] =>
  Array.from(
    panel.querySelectorAll<HTMLElement>(
      ":is([role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio']):not([aria-disabled='true'])",
    ),
  ).filter((entry) => entry.closest(".k2b-dropdown__submenu") === panel);

/**
 * One level of a menu: which of its rows has its submenu open. The pointer and the focus on the level's rows decide:
 * after the pointer rests on a row, that row's submenu opens or the open one closes; a move towards the open submenu
 * closes nothing; focus on another row closes it at once.
 */
type MenuLevel = {
  open: Accessor<HTMLElement | undefined>;
  /** Opens a row's submenu, or closes the open one with `undefined`, at once. */
  set: (row: HTMLElement | undefined) => void;
  /** The pointer reached the open submenu: nothing pending changes it. */
  hold: () => void;
};

const levels = new WeakMap<MenuContextValue, MenuLevel>();

/** The level of the rows under `menu`, created with its first submenu row; it listens on the element around them. */
const levelOf = (menu: MenuContextValue, row: HTMLElement): MenuLevel => {
  const known = levels.get(menu);
  if (known) return known;
  const [open, setOpen] = createRoot(() => createSignal<HTMLElement>());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: Point | undefined;
  let before: Point | undefined;
  let hovered: Element | undefined;
  const hold = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const set = (next: HTMLElement | undefined) => {
    hold();
    setOpen(() => next);
  };
  const level: MenuLevel = { open, set, hold };
  levels.set(menu, level);
  // The rows of this level, not those of a submenu inside it.
  const host = row.parentElement?.closest<HTMLElement>(".k2b-dropdown__submenu, [role='menu'], [role='dialog'], [role='listbox']");
  const own = host?.classList.contains("k2b-dropdown__submenu") ? host : null;
  const rowOf = (target: EventTarget | null) => {
    const entry = target instanceof Element ? target.closest("[role^='menuitem']") : null;
    return entry && entry.closest(".k2b-dropdown__submenu") === own ? entry : undefined;
  };
  host?.addEventListener("pointermove", (event) => {
    before = last;
    last = { x: event.clientX, y: event.clientY };
    const entry = rowOf(event.target);
    if (event.pointerType === "touch" || !entry || entry === hovered) return;
    hovered = entry;
    hold();
    const current = open();
    if (current === entry) return;
    const panel = current ? document.getElementById(`${current.id}-menu`) : null;
    const towards = Boolean(panel && before && inCorridor(before, last, panel.getBoundingClientRect()));
    timer = setTimeout(() => setOpen(() => entry as HTMLElement), towards ? CORRIDOR_DELAY : DELAY);
  });
  host?.addEventListener("pointerleave", () => {
    hovered = undefined;
  });
  host?.addEventListener("focusin", (event) => {
    const entry = rowOf(event.target);
    if (entry && open() && entry !== open()) set(undefined);
  });
  return level;
};

/**
 * An open submenu beside its row. It shows in the top layer, owns its keys, and closes with the menu around it, a
 * change of the window's size, or a scroll outside it.
 */
function SubmenuPanel(props: {
  id: string;
  row: HTMLButtonElement;
  label: string;
  items: readonly DropdownItem[];
  depth: number;
  close: (restoreFocus?: boolean) => void;
  level: MenuLevel;
  /** Changes whenever the keyboard asks for the first entry. */
  focus: () => number;
  hide: () => void;
}): JSX.Element {
  let panel!: HTMLDivElement;
  const rtl = () => getComputedStyle(props.row).direction === "rtl";
  const place = () => {
    if (!panel.isConnected) return;
    const host = props.row.closest<HTMLElement>("[role='menu'], [role='dialog'], [role='listbox']") ?? props.row;
    const at = placeSubmenu(
      props.row.getBoundingClientRect(),
      host.getBoundingClientRect(),
      panel.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight },
      rtl(),
    );
    panel.style.left = `${at.left}px`;
    panel.style.top = `${at.top}px`;
    panel.dataset.side = at.side;
  };
  const onKey = (event: KeyboardEvent) => {
    const items = ownEntries(panel);
    if (focusMenuRow(items, event.key) || focusRowSegment(items, event.key)) {
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === "Escape" || event.key === (rtl() ? "ArrowRight" : "ArrowLeft")) {
      // Only this level closes; the menu around it stays, as the browser's own Escape would close it.
      event.preventDefault();
      event.stopPropagation();
      props.hide();
    }
  };
  // The menu around it closing, the window changing size, or a scroll outside it closes it too: it would come loose
  // from its row.
  const host = props.row.parentElement?.closest<HTMLElement>("[popover]");
  const closed = (event: Event) => {
    if (event.type === "scroll" && event.target instanceof Node && panel.contains(event.target)) return;
    if (event.type !== "toggle" || (event as ToggleEvent).newState === "closed") props.level.set(undefined);
  };
  host?.addEventListener("toggle", closed);
  window.addEventListener("resize", closed);
  window.addEventListener("scroll", closed, true);
  onCleanup(() => {
    host?.removeEventListener("toggle", closed);
    window.removeEventListener("resize", closed);
    window.removeEventListener("scroll", closed, true);
    // Closed by the pointer resting elsewhere or by a resize, with the keyboard inside: the focus goes back to its row
    // rather than to the page.
    if (panel.contains(document.activeElement) && props.row.isConnected) props.row.focus();
  });
  createEffect(
    on(props.focus, (request) => {
      if (request) queueMicrotask(() => focusMenuRow(ownEntries(panel), "Home"));
    }),
  );
  return (
    <div
      ref={(element) => {
        panel = element;
        inheritUiScope(element, props.row);
        queueMicrotask(() => {
          if (!element.isConnected) return;
          if (typeof element.showPopover === "function") element.showPopover();
          place();
        });
      }}
      id={`${props.id}-menu`}
      popover="manual"
      role="menu"
      aria-label={props.label}
      class="k2b-dropdown__menu k2b-dropdown__submenu"
      data-depth={props.depth}
      on:keydown={onKey}
      onPointerEnter={() => props.level.hold()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <DropdownItems items={props.items} close={props.close} depth={props.depth} />
    </div>
  );
}

/** A row with "▸" that opens its submenu beside it, or in a phone sheet in the sheet's place (K16). */
export function SubmenuRow(props: { item: DropdownSubmenu }): JSX.Element {
  const menu = useContext(MenuContext);
  if (!menu) throw new Error("A submenu row must be inside a menu");
  // A list box cannot open a menu: there the entries stand under the row's name, as a section's do.
  if (menu.role === "option")
    return (
      <DropdownItems
        items={[{ sectionLabel: props.item.label, items: flatEntries(props.item.submenu) }]}
        close={menu.close}
        role="option"
      />
    );
  const id = `k2b-submenu-${createUniqueId().replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  // A fourth level is not offered (K16): its row stays, but cannot open.
  const disabled = () => Boolean(props.item.disabled) || menu.depth >= MAX_DEPTH;
  const [focus, setFocus] = createSignal(0);
  const [level, setLevel] = createSignal<MenuLevel>();
  const open = () => level()?.open() === row;
  let row!: HTMLButtonElement;
  onMount(() => {
    if (!menu.drill) setLevel(levelOf(menu, row));
  });
  const show = (moveFocus: boolean) => {
    if (disabled()) return;
    if (menu.drill) return menu.drill(props.item, row);
    if (moveFocus) setFocus((request) => request + 1);
    level()?.set(row);
  };
  const onRowKey = (event: KeyboardEvent) => {
    if (event.key !== (getComputedStyle(row).direction === "rtl" ? "ArrowLeft" : "ArrowRight")) return;
    event.preventDefault();
    event.stopPropagation();
    show(true);
  };
  // The row and its submenu stand together in an element without a role, as a menu holds only its entries.
  return (
    <div role="none" class="k2b-dropdown__subgroup">
      <button
        ref={row}
        type="button"
        role={menu.role}
        tabIndex={-1}
        class={`k2b-dropdown__item k2b-dropdown__item--submenu ${props.item.class ?? ""}`}
        aria-label={props.item.ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-controls={open() ? `${id}-menu` : undefined}
        aria-disabled={disabled() ? "true" : undefined}
        disabled={disabled()}
        data-open={open() ? "true" : undefined}
        data-danger={props.item.variant === "danger" ? "true" : undefined}
        data-accent={props.item.variant === "accent" ? "true" : undefined}
        on:keydown={onRowKey}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          // Enter and Space click with no pointer: the keyboard goes into the submenu, a pointer stays where it is.
          show(event.detail === 0);
        }}
      >
        {itemContent({ ...props.item, children: props.item.label })}
        <i class="ti ti-chevron-right k2b-dropdown__more" aria-hidden="true" />
      </button>
      <Show when={open() && level()}>
        {(current) => (
          <SubmenuPanel
            id={id}
            row={row}
            label={props.item.label}
            items={props.item.submenu}
            depth={menu.depth + 1}
            close={menu.close}
            level={current()}
            focus={focus}
            hide={() => {
              current().set(undefined);
              row.focus();
            }}
          />
        )}
      </Show>
    </div>
  );
}
