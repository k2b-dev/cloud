import { type Accessor, createMemo, createSignal, onCleanup } from "solid-js";
import { unwrap } from "solid-js/store";

/**
 * How long a task the reader just ticked off stays in view before it collapses when the view's filters no longer show
 * it, counted from the reader's last tick or pointer movement over the view. 700 ms lets the eye catch the filled
 * check and the struck-through title, which takes about half a second. While the reader keeps ticking or moves the
 * pointer towards the next task, the rows wait, so none moves under the pointer; then they collapse together.
 */
export const LEAVE_DELAY_MS = 700;
/** How long the row takes to collapse; the collapse transition uses the same duration. */
export const COLLAPSE_MS = 200;

/** A plain copy of an item a view shows, which later refreshes of the view's store leave as it is. */
export const snapshotOf = <T extends object>(item: T): T => structuredClone(unwrap(item));

type Held<T> = { item: T; completed: boolean; undo?: () => void; left: boolean; collapsing: boolean };

/**
 * Lays the items out as `next` has them and keeps every held item that `previous` showed and `next` dropped right
 * after the item it followed, so a refresh does not take a row away under the pointer.
 */
export const keepHeld = <T extends { id: string }>(previous: readonly T[], next: readonly T[], held: ReadonlyMap<string, T>): T[] => {
  const present = new Set(next.map((item) => item.id));
  const after = new Map<string | null, T[]>();
  let anchor: string | null = null;
  for (const item of previous) {
    const kept = held.get(item.id);
    if (present.has(item.id)) anchor = item.id;
    else if (kept) {
      after.set(anchor, [...(after.get(anchor) ?? []), kept]);
      anchor = item.id;
    }
  }
  // A kept item anchored on another kept item follows it.
  const place = (id: string | null, out: T[]) => {
    for (const kept of after.get(id) ?? []) {
      out.push(kept);
      place(kept.id, out);
    }
  };
  const out: T[] = [];
  place(null, out);
  for (const item of next) {
    out.push(item);
    place(item.id, out);
  }
  return out;
};

export type LeavingItems<T extends { id: string }> = {
  /** Items held in view by ID, as `keepHeld` takes them: as the view showed them before the change. */
  held: Accessor<ReadonlyMap<string, T>>;
  /** The completion a held item shows, or undefined for an item that is not held. */
  completed: (id: string) => boolean | undefined;
  /** The Undo a held item offers; none while its change or its Undo still runs. */
  undo: (id: string) => (() => void) | undefined;
  /** Whether the held item is collapsing now. */
  collapsing: (id: string) => boolean;
  /**
   * Keeps the item in view as given, wherever the view showed it, showing the given completion, until `leave` or
   * `release`. A running leave stops, an offered Undo is withdrawn, and the other held items wait again.
   */
  hold: (item: T, completed: boolean) => void;
  /** Lets unticking the held item run the Undo its confirmation offers. */
  offerUndo: (id: string, undo: () => void) => void;
  /** The view no longer has the item: it collapses and goes once the reader paused for `LEAVE_DELAY_MS`. */
  leave: (id: string) => void;
  /** Lets go of the item at once, because the view has it again or never should. */
  release: (id: string) => void;
  /** The reader moves the pointer over the view, maybe towards the next task: held items wait again. */
  postpone: () => void;
};

/**
 * Holds items a view is about to lose, such as a task ticked off under a filter that hides completed tasks. Ticking
 * another item is never held up; the items that left collapse together once the reader paused. Timers stop with the
 * owner.
 */
export const createLeavingItems = <T extends { id: string }>(): LeavingItems<T> => {
  const [entries, setEntries] = createSignal<ReadonlyMap<string, Held<T>>>(new Map());
  /** Whether `LEAVE_DELAY_MS` have passed since the reader's last tick or pointer movement. */
  let quiet = true;
  let pause: ReturnType<typeof setTimeout> | undefined;
  const collapses = new Map<string, ReturnType<typeof setTimeout>>();
  const update = (change: (next: Map<string, Held<T>>) => void) =>
    setEntries((current) => {
      const next = new Map(current);
      change(next);
      return next;
    });
  const stopCollapse = (id: string) => {
    clearTimeout(collapses.get(id));
    collapses.delete(id);
  };
  const release = (id: string) => {
    stopCollapse(id);
    if (entries().has(id)) update((next) => next.delete(id));
  };
  /** Collapses every item that left and lets it go once its collapse is over. */
  const collapseLeft = () => {
    const ids = [...entries()].filter(([, entry]) => entry.left && !entry.collapsing).map(([id]) => id);
    if (ids.length === 0) return;
    update((next) => {
      for (const id of ids) next.set(id, { ...next.get(id)!, collapsing: true });
    });
    for (const id of ids)
      collapses.set(
        id,
        setTimeout(() => release(id), COLLAPSE_MS),
      );
  };
  /** The reader acted: the items that left wait until `LEAVE_DELAY_MS` have passed without another action. */
  const restartPause = () => {
    quiet = false;
    clearTimeout(pause);
    pause = setTimeout(() => {
      quiet = true;
      collapseLeft();
    }, LEAVE_DELAY_MS);
  };
  onCleanup(() => {
    clearTimeout(pause);
    for (const timer of collapses.values()) clearTimeout(timer);
    collapses.clear();
  });

  return {
    held: createMemo(() => new Map([...entries()].map(([id, entry]) => [id, entry.item]))),
    completed: (id) => entries().get(id)?.completed,
    undo: (id) => entries().get(id)?.undo,
    collapsing: (id) => entries().get(id)?.collapsing ?? false,
    hold: (item, completed) => {
      restartPause();
      stopCollapse(item.id);
      update((next) => next.set(item.id, { item, completed, left: false, collapsing: false }));
    },
    offerUndo: (id, undo) => {
      const entry = entries().get(id);
      if (entry) update((next) => next.set(id, { ...entry, undo }));
    },
    leave: (id) => {
      const entry = entries().get(id);
      if (!entry || entry.left) return;
      update((next) => next.set(id, { ...entry, left: true }));
      if (quiet) collapseLeft();
    },
    release,
    postpone: () => {
      if (entries().size > 0) restartPause();
    },
  };
};
