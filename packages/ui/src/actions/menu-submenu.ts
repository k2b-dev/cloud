import { type Accessor, createSignal, onCleanup } from "solid-js";

/** How long the pointer rests on a row with "▸" before its menu opens beside it (K16). */
export const SUBMENU_DELAY = 150;
/** How long a move towards an open submenu keeps it open while the pointer crosses other rows. */
export const SUBMENU_CORRIDOR_DELAY = 300;
/** A menu, its submenu, and one more: deeper entries are not offered (K16). */
export const MAX_MENU_DEPTH = 3;
/** The least room above and below a submenu that still counts as on the way to it. */
const EDGE = 8;

type Point = { x: number; y: number };
type Box = Pick<DOMRect, "left" | "top" | "right" | "bottom">;

const sign = (p: Point, a: Point, b: Point) => (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);

/**
 * Whether `to` lies in the corridor from `from` to the submenu: the triangle between the earlier pointer position and
 * the submenu's near edge. A pointer moving through it is on its way to the submenu.
 */
export const inCorridor = (from: Point, to: Point, menu: Box): boolean => {
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

/**
 * One level of a menu: which of its rows has its submenu open. Rows report the pointer and focus; a submenu opens or
 * another row takes over after the pointer rested, and a move towards the open submenu does not close it.
 */
export type MenuLevel = {
  open: Accessor<string | undefined>;
  /** Opens a row's submenu, or closes the open one with `undefined`, at once: a click, a key, focus elsewhere. */
  set: (id: string | undefined) => void;
  /** The pointer entered a row; after the pointer rests, that row decides which submenu is open. */
  enter: (id: string, point: Point) => void;
  /** The pointer moved over the level. */
  move: (point: Point) => void;
  /** The pointer reached the open submenu: nothing pending changes it. */
  hold: () => void;
};

export const createMenuLevel = (): MenuLevel => {
  const [open, setOpen] = createSignal<string | undefined>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: Point | undefined;
  let before: Point | undefined;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const set = (id: string | undefined) => {
    clear();
    setOpen(id);
  };
  const move = (point: Point) => {
    before = last;
    last = point;
  };
  const enter = (id: string, point: Point) => {
    move(point);
    clear();
    const current = open();
    if (current === id) return;
    const panel = current ? document.getElementById(`${current}-menu`) : null;
    const towards = Boolean(panel && before && inCorridor(before, point, panel.getBoundingClientRect()));
    // A row without a submenu has nothing to open: it only closes the open one, after the same rest.
    timer = setTimeout(
      () => {
        timer = undefined;
        setOpen(id);
      },
      towards ? SUBMENU_CORRIDOR_DELAY : SUBMENU_DELAY,
    );
  };
  onCleanup(clear);
  return { open, set, enter, move, hold: clear };
};
