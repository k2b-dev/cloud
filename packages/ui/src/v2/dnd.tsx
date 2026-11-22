/**
 * @k2b/ui v2 drag and drop: a thin Solid binding over ui-sdk core.
 *
 * - `SortableList`: a ui-sdk primitive around `createReorder` (pointer, touch, keyboard, announcements, dragged copy,
 *   auto-scroll at the edges, focus kept across moves). Only the German wording and the look are ours.
 * - `createDragOnto`: drag an item onto a target surface (a folder). ui-sdk has no behaviour for this, only the parts:
 *   `bindDrag`, `bindDragPreview`, `createAutoScroll`, `announce`. This file adds the target lookup, the keyboard
 *   pickup, and the touch hold.
 */
import {
  announce,
  bindDrag,
  bindDragPreview,
  createAutoScroll,
  createChange,
  createReorder,
  createRovingFocus,
  definePrimitive,
  prepareAnnouncements,
  type ReorderDraft,
  type ReorderMessage,
} from "@ui-sdk/core";
import { usePart, usePrimitive } from "@ui-sdk/solid/primitive";
import { createSignal, For, onCleanup } from "solid-js";
import type { JSX } from "@solidjs/web";

// ── Sorting ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** German announcements for a sortable list (ui-sdk's defaults are English). */
export const sortableMessage = ({ type, label, position, total }: ReorderMessage): string => {
  const at = `Position ${position} von ${total}`;
  if (type === "grab") return `${label} aufgenommen, ${at}. Pfeiltasten verschieben, Leertaste legt ab, Escape bricht ab.`;
  if (type === "move") return `${label}, ${at}.`;
  if (type === "drop") return `${label} abgelegt, ${at}.`;
  return `Abgebrochen. ${label} bleibt auf ${at}.`;
};

type SortableOptions = {
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[]) => void;
  label?: (key: string) => string | undefined;
};

export const sortable = definePrimitive({
  name: "k2-sortable",
  options: { value: "value", defaultValue: "value", onValueChange: "callback", label: "value" },
  controlled: ["value"],
  state: (options: SortableOptions) => ({
    value: options.value ?? options.defaultValue ?? [],
    moving: null as ReorderDraft | null,
    focused: null as string | null,
  }),
  sync: (options) => (options.value === undefined ? {} : { value: options.value }),
  api: (context) => {
    const change = createChange(context);
    const roving = createRovingFocus(context, { slot: "item", key: "focused" });
    const reorder = createReorder(context, {
      slot: "item",
      key: "value",
      draft: "moving",
      preview: true,
      createAutoScroll: { edge: 40, speed: 12 },
      set: (value, details) => change("value", value, details),
      label: (key) => context.options().label?.(key),
      message: sortableMessage,
    });
    return { roving, reorder };
  },
  slots: (slot) => ({
    // The order to render: the draft during a move, the committed value otherwise. Slot state is what Solid tracks;
    // handle.state is a plain snapshot.
    root: slot<{}, { order: string[] }>({
      state: (state, part) => ({ order: part.api.reorder.order(state) }),
      role: "listbox",
      keys: { none: "Each item handles its own keys." },
      attrs: () => ({ "aria-roledescription": "sortierbare Liste" }),
      bind: (el) => {
        prepareAnnouncements(el.ownerDocument);
        return () => {};
      },
    }),
    item: slot<{ value: string }>({
      props: { value: "key" },
      role: "option",
      focus: "roving",
      press: () => {},
      attrs: (state, part) => ({
        "aria-selected": String(state.moving?.key === part.key),
        "aria-roledescription": "verschiebbar",
        tabindex: part.api.roving.tabIndex(state, part),
        "data-grabbed": state.moving?.key === part.key ? "" : undefined,
      }),
      on: {
        keydown: (event, { el, api, key }) => {
          if (!api.reorder.keydown(event, String(key)) && el) api.roving.keydown(event, el);
        },
        pointerdown: (event, { api, key }) => api.reorder.pointerdown(event as PointerEvent, String(key)),
      },
      bind: (el, part) => {
        const cleanups = [part.api.roving.bind(el, part), part.api.reorder.bind(el, part)];
        return () => cleanups.forEach((cleanup) => cleanup());
      },
    }),
  }),
});

/** A list sorted by drag, touch or keyboard (Space, arrows, Space; Escape cancels). Items render from `children`. */
export function SortableList(props: {
  label: string;
  value: string[];
  onValueChange: (value: string[]) => void;
  itemLabel: (key: string) => string;
  children: (key: string) => JSX.Element;
}) {
  const handle = usePrimitive(sortable, () => ({ value: props.value, onValueChange: props.onValueChange, label: props.itemLabel }));
  return usePart(
    handle,
    "root",
    undefined,
    {
      "aria-label": props.label,
      class: "k2-sortable",
      children: (state: { order: string[] }) => (
        <For each={state.order}>
          {(key) => usePart(sortable, "item", () => ({ value: key }), { class: "k2-sortable__item", children: props.children(key) }, "li")}
        </For>
      ),
    },
    "ul",
  );
}

// ── Drag onto a target ─────────────────────────────────────────────────────────────────────────────────────────────

export type DropTarget = { id: string; label: string };

/** Touch: a hold of this long lifts the item; moving the finger first scrolls. Mouse and pen drag after a few pixels. */
const TOUCH_HOLD_MS = 400;
const TOUCH_SLOP_PX = 8;
const MOUSE_THRESHOLD_PX = 6;

/**
 * Drag items onto target surfaces marked with `data-drop-target="<id>"`.
 * Pointer: press and move (touch: hold first). Keyboard on the item's grip: Space or Enter lifts, Up/Down choose the
 * target, Enter or Space drops, Escape or Tab cancel. Every step is announced; nothing changes before the drop.
 */
export function createDragOnto(options: {
  targets: () => DropTarget[];
  itemLabel: (key: string) => string;
  accepts?: (key: string, target: string) => boolean;
  onDrop: (key: string, target: string) => void;
}) {
  const [moving, setMoving] = createSignal<string | null>(null);
  const [over, setOver] = createSignal<string | null>(null);
  const label = (target: string | null) => options.targets().find((entry) => entry.id === target)?.label ?? "";
  const accepted = (key: string, target: string) => options.accepts?.(key, target) ?? true;
  let stop: (() => void) | undefined;
  onCleanup(() => stop?.());

  const finish = (key: string, target: string | null, by: "drop" | "cancel") => {
    stop = undefined;
    setMoving(null);
    setOver(null);
    if (by === "drop" && target) {
      options.onDrop(key, target);
      announce(`${options.itemLabel(key)} verschoben nach ${label(target)}.`, { priority: "assertive" });
    } else {
      announce("Abgebrochen, nichts geändert.", { priority: "assertive" });
    }
  };

  const targetAt = (key: string, x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-target]");
    const id = el?.dataset.dropTarget ?? null;
    return id && accepted(key, id) ? id : null;
  };

  const startPointerDrag = (el: HTMLElement, event: PointerEvent, key: string, threshold: number) => {
    let preview: ReturnType<typeof bindDragPreview> | undefined;
    let point = { x: event.clientX, y: event.clientY };
    const retarget = () => {
      const target = targetAt(key, point.x, point.y);
      if (target !== over()) {
        setOver(target);
        if (target) announce(label(target));
      }
      preview?.el.toggleAttribute("data-over", Boolean(target));
    };
    const scroll = createAutoScroll({ edge: 48, speed: 14, ignore: () => preview?.el, onScroll: retarget });
    const end = () => {
      scroll.stop();
      preview?.remove();
    };
    stop = bindDrag(el, event, {
      threshold,
      cancelOnEscape: true,
      onStart: () => {
        setMoving(key);
        preview = bindDragPreview(el, point);
        announce(`${options.itemLabel(key)} aufgenommen. Über einem Ordner loslassen.`);
      },
      onMove: ({ x, y, event: move }) => {
        move.preventDefault();
        point = { x, y };
        preview?.move(x, y);
        scroll.update(x, y);
        retarget();
      },
      onEnd: (_event, canceled) => {
        end();
        // A press that never passed the threshold is a click, not a drag.
        if (!moving()) return;
        finish(key, canceled ? null : over(), canceled || !over() ? "cancel" : "drop");
      },
    });
    const cleanup = stop;
    stop = () => {
      cleanup();
      end();
    };
  };

  /** Bind on the item's pointerdown. */
  const pointerdown = (event: PointerEvent, el: HTMLElement, key: string) => {
    if (event.button !== 0 || moving()) return;
    if (event.pointerType !== "touch") return startPointerDrag(el, event, key, MOUSE_THRESHOLD_PX);
    // Touch: the finger scrolls unless it holds still. After the hold, a non-passive touchmove stops the scroll.
    const start = { x: event.clientX, y: event.clientY };
    const blockScroll = (touch: TouchEvent) => touch.cancelable && touch.preventDefault();
    const quit = () => {
      clearTimeout(timer);
      el.removeEventListener("pointermove", moved);
      el.removeEventListener("pointerup", quit);
      el.removeEventListener("pointercancel", quit);
    };
    const moved = (move: PointerEvent) => {
      if (Math.hypot(move.clientX - start.x, move.clientY - start.y) > TOUCH_SLOP_PX) quit();
    };
    const timer = setTimeout(() => {
      quit();
      el.addEventListener("touchmove", blockScroll, { passive: false });
      const release = () => el.removeEventListener("touchmove", blockScroll);
      el.addEventListener("pointerup", release, { once: true });
      el.addEventListener("pointercancel", release, { once: true });
      startPointerDrag(el, event, key, 0);
    }, TOUCH_HOLD_MS);
    el.addEventListener("pointermove", moved);
    el.addEventListener("pointerup", quit);
    el.addEventListener("pointercancel", quit);
  };

  /** Bind on the grip's keydown. */
  const keydown = (event: KeyboardEvent, key: string) => {
    const current = moving();
    const choices = options.targets().filter((target) => accepted(key, target.id));
    if (!current) {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      setMoving(key);
      setOver(choices[0]?.id ?? null);
      announce(
        `${options.itemLabel(key)} aufgenommen. Ziel: ${label(choices[0]?.id ?? null)}, 1 von ${choices.length}. Pfeiltasten wählen den Ordner, Enter legt ab, Escape bricht ab.`,
        { priority: "assertive" },
      );
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const at = choices.findIndex((target) => target.id === over());
      const next = (at + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length;
      setOver(choices[next]!.id);
      announce(`${choices[next]!.label}, ${next + 1} von ${choices.length}.`, { priority: "assertive" });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      finish(current, over(), "drop");
    } else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      finish(current, null, "cancel");
    }
  };

  return { moving, over, pointerdown, keydown, stop: () => stop?.() };
}
