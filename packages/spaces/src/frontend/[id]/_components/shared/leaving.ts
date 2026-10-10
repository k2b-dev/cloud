import { type Accessor, createMemo, createSignal, onCleanup } from "solid-js";
import { unwrap } from "solid-js/store";

/**
 * How long a task the reader just ticked off stays in view, counted from the tick, before it collapses when the view's
 * filters no longer show it. 700 ms lets the eye catch the filled check and the struck-through title, which takes
 * about half a second, and stays short enough that ticking several tasks in a row does not feel held up.
 */
export const LEAVE_DELAY_MS = 700;
/** How long the row takes to collapse; the collapse transition uses the same duration. */
export const COLLAPSE_MS = 200;

/** A plain copy of an item a view shows, which later refreshes of the view's store leave as it is. */
export const snapshotOf = <T extends object>(item: T): T => structuredClone(unwrap(item));

type Held<T> = { item: T; since: number; collapsing: boolean };

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
  /** Items held in view by ID, as `keepHeld` takes them. */
  held: Accessor<ReadonlyMap<string, T>>;
  /** Whether the held item is collapsing now. */
  collapsing: (id: string) => boolean;
  /** Keeps the item in view as given, wherever the view showed it, until `leave` or `release`; a running leave stops. */
  hold: (item: T) => void;
  /** The view no longer has the item: it stays until `LEAVE_DELAY_MS` after its hold, then collapses and goes. */
  leave: (id: string) => void;
  /** Lets go of the item at once, because the view has it again or never should. */
  release: (id: string) => void;
};

/**
 * Holds items a view is about to lose, such as a task ticked off under a filter that hides completed tasks. Every item
 * keeps its own timer, so ticking another one never waits for or cuts short the first. Timers stop with the owner.
 */
export const createLeavingItems = <T extends { id: string }>(): LeavingItems<T> => {
  const [entries, setEntries] = createSignal<ReadonlyMap<string, Held<T>>>(new Map());
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const stop = (id: string) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
  };
  const update = (id: string, entry: Held<T> | null) =>
    setEntries((current) => {
      const next = new Map(current);
      if (entry) next.set(id, entry);
      else next.delete(id);
      return next;
    });
  const release = (id: string) => {
    stop(id);
    if (entries().has(id)) update(id, null);
  };
  onCleanup(() => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  });

  return {
    held: createMemo(() => new Map([...entries()].map(([id, entry]) => [id, entry.item]))),
    collapsing: (id) => entries().get(id)?.collapsing ?? false,
    hold: (item) => {
      stop(item.id);
      update(item.id, { item, since: Date.now(), collapsing: false });
    },
    leave: (id) => {
      const entry = entries().get(id);
      if (!entry || timers.has(id)) return;
      const collapse = () => {
        const current = entries().get(id);
        if (!current) return;
        update(id, { ...current, collapsing: true });
        timers.set(
          id,
          setTimeout(() => release(id), COLLAPSE_MS),
        );
      };
      timers.set(id, setTimeout(collapse, Math.max(0, entry.since + LEAVE_DELAY_MS - Date.now())));
    },
    release,
  };
};
