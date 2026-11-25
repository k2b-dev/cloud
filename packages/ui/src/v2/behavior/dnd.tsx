/**
 * Drag and drop for v2.
 *
 * - `SortableList`: a primitive around core's `createReorder` (pointer, touch, keyboard, announcements, dragged copy,
 *   auto-scroll, focus kept across moves). Rows move live while dragging.
 * - `TransferBoard`: items move between lists (core's `createTransfer`), live, with the same inputs.
 * - `createDragOnto`: drag an item onto a target surface. Core has only the parts for this (`bindDrag`,
 *   `bindDragPreview`, `createAutoScroll`, `announce`), so the behaviour is ours.
 *
 * Announcements come from `messages.ts`, in the inherited render locale. The primitive definitions are
 * framework-free; only the bindings at the bottom of each section are Solid 1.
 */
import {
  announce,
  bindDrag,
  bindDragPreview,
  bindHold,
  createAutoScroll,
  createChange,
  createReorder,
  createRovingFocus,
  createTransfer,
  definePrimitive,
  prepareAnnouncements,
  type ReorderDraft,
  type ReorderMessage,
  reorderMessage,
  type TransferDraft,
  type TransferMessage,
  transferMessage,
} from "@ui-sdk/core";
import { createSignal, For, type JSX, onCleanup, onMount } from "solid-js";
import { type PartProps, part, usePrimitive } from "./adapter";
import { type BehaviorMessages, useBehaviorMessages } from "./messages";

/** Lists by name, each the keys of its items in order. */
export type Lists = Record<string, string[]>;

const reorderText = (t: BehaviorMessages, { type, ...move }: ReorderMessage): string =>
  type === "grab" ? t.sortGrab(move) : type === "move" ? t.sortMove(move) : type === "drop" ? t.sortDrop(move) : t.sortCancel(move);

const transferText = (t: BehaviorMessages, { type, ...move }: TransferMessage): string =>
  type === "grab"
    ? t.transferGrab(move)
    : type === "move"
      ? t.transferMove(move)
      : type === "drop"
        ? t.transferDrop(move)
        : t.transferCancel(move);

// ── Sorting ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type SortableOptions = {
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[]) => void;
  label?: (key: string) => string | undefined;
  messages?: () => BehaviorMessages;
};

const sortable = definePrimitive({
  name: "k2-sortable",
  options: { value: "value", defaultValue: "value", onValueChange: "callback", label: "value", messages: "value" },
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
      message: (message) => {
        const messages = context.options().messages;
        return messages ? reorderText(messages(), message) : reorderMessage(message);
      },
    });
    return { roving, reorder };
  },
  slots: (slot) => ({
    // The order to render: the draft during a move, the committed value otherwise.
    root: slot<{}, { order: string[] }>({
      state: (state, part) => ({ order: part.api.reorder.order(state) }),
      role: "listbox",
      keys: { none: "Each item handles its own keys." },
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

const orderOf = (state: Record<string, unknown>): string[] =>
  Array.isArray(state.order) ? state.order.filter((key): key is string => typeof key === "string") : [];

/**
 * A list sorted by drag, touch or keyboard (Space, arrows, Space; Escape cancels). Rows move while dragging. Items
 * render from `children`; `root` and `item` take element props (class, test ids) for the v2 look.
 */
export function SortableList(props: {
  label: string;
  value: string[];
  onValueChange: (value: string[]) => void;
  itemLabel: (key: string) => string;
  children: (key: string) => JSX.Element;
  root?: PartProps;
  item?: (key: string) => PartProps;
}) {
  const t = useBehaviorMessages();
  const handle = usePrimitive(sortable, () => ({
    value: props.value,
    onValueChange: props.onValueChange,
    label: props.itemLabel,
    messages: t,
  }));
  return part(
    handle,
    "root",
    undefined,
    {
      ...props.root,
      "aria-label": props.label,
      "aria-roledescription": t().sortable,
      children: (state) => (
        <For each={orderOf(state)}>
          {(key) =>
            part(
              handle,
              "item",
              () => ({ value: key }),
              { ...props.item?.(key), "aria-roledescription": t().movable, children: props.children(key) },
              "li",
            )
          }
        </For>
      ),
    },
    "ul",
  );
}

// ── Moving between lists ────────────────────────────────────────────────────────────────────────────────────────────

type TransferOptions = {
  value?: Lists;
  onValueChange?: (value: Lists) => void;
  label?: (key: string) => string | undefined;
  listLabel?: (list: string) => string | undefined;
  messages?: () => BehaviorMessages;
};

const transferLists = definePrimitive({
  name: "k2-transfer",
  options: { value: "value", onValueChange: "callback", label: "value", listLabel: "value", messages: "value" },
  controlled: ["value"],
  state: (options: TransferOptions) => ({
    value: options.value ?? {},
    moving: null as TransferDraft | null,
    focused: null as string | null,
  }),
  sync: (options) => (options.value === undefined ? {} : { value: options.value }),
  api: (context) => {
    const change = createChange(context);
    const roving = createRovingFocus(context, { slot: "item", key: "focused" });
    const transfer = createTransfer(context, {
      key: "value",
      draft: "moving",
      set: (value, details) => change("value", value, details),
      label: (key) => context.options().label?.(key),
      listLabel: (list) => context.options().listLabel?.(list),
      message: (message) => {
        const messages = context.options().messages;
        return messages ? transferText(messages(), message) : transferMessage(message);
      },
    });
    return { roving, transfer };
  },
  slots: (slot) => ({
    // The lists to render: the draft during a move, the committed value otherwise.
    root: slot<{}, { lists: Lists }>({
      state: (state, part) => ({ lists: part.api.transfer.lists(state) }),
      bind: (el) => {
        prepareAnnouncements(el.ownerDocument);
        return () => {};
      },
    }),
    list: slot<{ value: string }>({
      props: { value: "key" },
      role: "listbox",
      keys: { none: "Each item handles its own keys." },
      bind: (el, part) => part.api.transfer.bindList(el, String(part.key)),
    }),
    item: slot<{ value: string }>({
      props: { value: "key" },
      role: "option",
      focus: "roving",
      press: () => {},
      attrs: (state, part) => ({
        "aria-selected": String(state.moving?.key === part.key),
        tabindex: part.api.roving.tabIndex(state, part),
        "data-grabbed": state.moving?.key === part.key ? "" : undefined,
      }),
      on: {
        keydown: (event, { el, api, key }) => {
          if (!api.transfer.keydown(event, String(key)) && el) api.roving.keydown(event, el);
        },
        pointerdown: (event, { api, key }) => api.transfer.pointerdown(event as PointerEvent, String(key)),
      },
      bind: (el, part) => {
        const cleanups = [part.api.roving.bind(el, part), part.api.transfer.bindItem(el, String(part.key))];
        return () => cleanups.forEach((cleanup) => cleanup());
      },
    }),
  }),
});

const listsOf = (state: Record<string, unknown>): Lists => {
  const lists: Lists = {};
  const value = state.lists;
  if (typeof value !== "object" || value === null) return lists;
  for (const [name, keys] of Object.entries(value)) {
    lists[name] = Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [];
  }
  return lists;
};

/**
 * Lists whose items move between them by drag, touch or keyboard (Space; arrows, Left/Right change the list; Space;
 * Escape cancels). `list(name, items)` renders the frame of one list around its `items`.
 */
export function TransferBoard(props: {
  value: Lists;
  onValueChange: (value: Lists) => void;
  listLabel: (list: string) => string;
  itemLabel: (key: string) => string;
  children: (key: string) => JSX.Element;
  list?: (name: string, items: JSX.Element) => JSX.Element;
  root?: PartProps;
  listProps?: (name: string) => PartProps;
  item?: (key: string) => PartProps;
}) {
  const t = useBehaviorMessages();
  const handle = usePrimitive(transferLists, () => ({
    value: props.value,
    onValueChange: props.onValueChange,
    label: props.itemLabel,
    listLabel: props.listLabel,
    messages: t,
  }));
  return part(handle, "root", undefined, {
    ...props.root,
    children: (state) => (
      <For each={Object.keys(listsOf(state))}>
        {(name) => {
          const items = part(
            handle,
            "list",
            () => ({ value: name }),
            {
              ...props.listProps?.(name),
              "aria-label": props.listLabel(name),
              children: (
                <For each={listsOf(state)[name]}>
                  {(key) =>
                    part(
                      handle,
                      "item",
                      () => ({ value: key }),
                      { ...props.item?.(key), "aria-roledescription": t().movable, children: props.children(key) },
                      "li",
                    )
                  }
                </For>
              ),
            },
            "ul",
          );
          return props.list ? props.list(name, items) : items;
        }}
      </For>
    ),
  });
}

// ── Drag onto a target ─────────────────────────────────────────────────────────────────────────────────────────────

export type DropTarget = { id: string; label: string };

/** Touch: a hold of this long lifts the item; moving the finger first scrolls. Mouse and pen drag after a few pixels. */
const TOUCH_HOLD_MS = 400;
const TOUCH_TOLERANCE_PX = 8;
const MOUSE_THRESHOLD_PX = 6;
/** Resting this long over a closed folder opens it, so a drag reaches a level below (guide: levels change after a visible rest). */
export const HOVER_OPEN_MS = 700;

/**
 * Drag items onto target surfaces marked with `data-drop-target="<id>"`. Spread `item(key)` on each item's element.
 * Pointer: press and move (touch: hold first, through core's `bindHold`). Keys on the item, or on an element in it
 * marked `data-k2-drag-handle` (a grip button): Space or Enter lifts, Up/Down choose the target, Enter or Space drops,
 * Escape or Tab cancel. Every step is announced; nothing changes before the drop.
 *
 * Core has the parts (`bindDrag`, `bindDragPreview`, `createAutoScroll`, `bindHold`, `announce`) but no drop targets,
 * so choosing a target is ours. Its one-drag-at-a-time session (`createDragSession`) is not exported, so the small
 * bookkeeping below is ours too. Solid 1 reads a signal's new value right after the write, so the logic reads its
 * signals directly.
 */
export function createDragOnto(options: {
  targets: () => DropTarget[];
  itemLabel: (key: string) => string;
  accepts?: (key: string, target: string) => boolean;
  onDrop: (key: string, target: string) => void;
  /** `false`: a finger never lifts an item (it scrolls, and a long press stays the context menu's). */
  touch?: boolean;
  /** The element the copy under the pointer is made from; it must stand in the page. Defaults to the item itself. */
  preview?: (key: string, item: HTMLElement, point: { x: number; y: number }) => HTMLElement;
  /** A pointer that rests on a target for `HOVER_OPEN_MS`, such as a closed folder that should open. */
  onRest?: (target: string) => void;
}) {
  const t = useBehaviorMessages();
  const [moving, setMoving] = createSignal<string | null>(null);
  const [over, setOver] = createSignal<string | null>(null);
  // a target under the pointer that does not take this item: it says so, and letting go there changes nothing
  const [refused, setRefused] = createSignal<string | null>(null);
  let rest: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(rest));
  const label = (target: string | null) => options.targets().find((entry) => entry.id === target)?.label ?? "";
  const accepted = (key: string, target: string) => options.accepts?.(key, target) ?? true;
  let stop: (() => void) | undefined;
  onCleanup(() => stop?.());

  const finish = (key: string, target: string | null, by: "drop" | "cancel") => {
    stop = undefined;
    clearTimeout(rest);
    setMoving(null);
    setOver(null);
    setRefused(null);
    if (by === "drop" && target) {
      options.onDrop(key, target);
      announce(t().ontoDrop({ label: options.itemLabel(key), target: label(target) }), { priority: "assertive" });
    } else {
      announce(t().ontoCancel, { priority: "assertive" });
    }
  };

  /** The target under the point, accepted or not. */
  const targetAt = (x: number, y: number): string | null => {
    // Geometry, not hit-testing: WebKit's elementsFromPoint misses the target while the copy sits in the top layer.
    // Only this drag's own targets count, so two boards on one page never take each other's items.
    const own = new Set(options.targets().map((target) => target.id));
    const el = [...document.querySelectorAll<HTMLElement>("[data-drop-target]")].find((target) => {
      if (target.closest("[data-drag-preview]") || !own.has(target.dataset.dropTarget ?? "")) return false;
      const rect = target.getBoundingClientRect();
      return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
    });
    return el?.dataset.dropTarget ?? null;
  };

  const startPointerDrag = (el: HTMLElement, event: PointerEvent, key: string, threshold: number) => {
    let preview: ReturnType<typeof bindDragPreview> | undefined;
    let point = { x: event.clientX, y: event.clientY };
    const retarget = () => {
      const under = targetAt(point.x, point.y);
      const target = under && accepted(key, under) ? under : null;
      setRefused(under && !target ? under : null);
      if (target !== over()) {
        setOver(target);
        clearTimeout(rest);
        if (target) {
          announce(label(target));
          const onRest = options.onRest;
          if (onRest) rest = setTimeout(() => over() === target && onRest(target), HOVER_OPEN_MS);
        }
      }
      preview?.el.toggleAttribute("data-over", Boolean(target));
      preview?.el.toggleAttribute("data-refused", Boolean(under && !target));
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
        const source = options.preview?.(key, el, point) ?? el;
        preview = bindDragPreview(source, point);
        // A compact copy hangs 16 px below the pointer, so the target under the pointer stays readable; a copy made
        // from its own element (a chip) keeps its own width.
        Object.assign(preview.el.style, {
          left: `${point.x - 16}px`,
          top: `${point.y + 16}px`,
          width: source === el ? `${Math.min(el.getBoundingClientRect().width, 360)}px` : "auto",
        });
        if (source !== el) source.remove();
        announce(t().ontoGrabPointer({ label: options.itemLabel(key) }));
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
        const target = over();
        finish(key, canceled ? null : target, canceled || !target ? "cancel" : "drop");
      },
    });
    const cleanup = stop;
    stop = () => {
      cleanup();
      end();
    };
  };

  const keydown = (event: KeyboardEvent, key: string, el: EventTarget | null) => {
    const current = moving();
    const choices = options.targets().filter((target) => accepted(key, target.id));
    if (!current) {
      if (event.key !== " " && event.key !== "Enter") return;
      // Only the item itself or its grip lifts it; Enter on a link or button inside the item stays theirs.
      const from = event.target;
      const handle = from instanceof Element ? from.closest("[data-k2-drag-handle]") : null;
      // The grip must be this item's own, not one of an item around it.
      if (from !== el && !(handle && el instanceof Element && el.contains(handle))) return;
      event.preventDefault();
      setMoving(key);
      setOver(choices[0]?.id ?? null);
      announce(t().ontoGrab({ label: options.itemLabel(key), target: label(choices[0]?.id ?? null), index: 1, total: choices.length }), {
        priority: "assertive",
      });
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const at = choices.findIndex((target) => target.id === over());
      const next = (at + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length;
      const choice = choices[next];
      if (!choice) return;
      setOver(choice.id);
      announce(t().ontoTarget({ target: choice.label, index: next + 1, total: choices.length }), { priority: "assertive" });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      finish(current, over(), "drop");
    } else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      finish(current, null, "cancel");
    }
  };

  /**
   * Props for one item's element (`ref` and `onKeyDown`). Call it where the item renders (inside its `For` row), so
   * its bindings end with the item. Spread it after the item's own props; an item that needs its own `ref` or
   * `onKeyDown` as well calls `item(key).ref(el)` and `item(key).onKeyDown(event)` from its own handlers.
   */
  const item = (key: string) => {
    let release: (() => void) | undefined;
    let element: HTMLElement | undefined;
    onCleanup(() => release?.());
    const bind = (el: HTMLElement) => {
      release?.();
      const press = (event: PointerEvent) => {
        if (event.button !== 0 || moving() || event.pointerType === "touch") return;
        // a press on a control inside the item (its "…", a box) is that control's
        const from = event.target instanceof Element ? event.target : null;
        if (from?.closest("button, input, select, textarea") && !from.closest("[data-k2-drag-handle]")) return;
        startPointerDrag(el, event, key, MOUSE_THRESHOLD_PX);
      };
      // After the hold, a non-passive touchmove keeps the page from scrolling under the dragged finger.
      const blockScroll = (touch: TouchEvent) => touch.cancelable && touch.preventDefault();
      const unblock = () => el.removeEventListener("touchmove", blockScroll);
      // Touch: core's hold lifts the item; a finger that moves first scrolls, and the long press opens neither iOS's
      // callout nor a context menu.
      const unhold = bindHold(el, {
        delay: TOUCH_HOLD_MS,
        tolerance: TOUCH_TOLERANCE_PX,
        keys: [],
        onPress: ({ input }) => input === "touch" && options.touch !== false && !moving(),
        onHold: ({ event }) => {
          if (!(event instanceof PointerEvent)) return false;
          el.addEventListener("touchmove", blockScroll, { passive: false });
          el.addEventListener("pointerup", unblock, { once: true });
          el.addEventListener("pointercancel", unblock, { once: true });
          startPointerDrag(el, event, key, 0);
          return false;
        },
      });
      // a link or picture in the item would start the browser's own drag, which ends the pointer's
      const native = (drag: DragEvent) => drag.preventDefault();
      el.addEventListener("pointerdown", press);
      el.addEventListener("dragstart", native);
      release = () => {
        el.removeEventListener("pointerdown", press);
        el.removeEventListener("dragstart", native);
        unblock();
        unhold();
      };
    };
    // Bound once the item is in the page, never in `ref`: Solid 1 calls `ref` on the node cloned from its template
    // before it is inserted, while its `ownerDocument` is still the template's inert document, and core's `bindHold`
    // listens for the press's moves and release on `el.ownerDocument`. Bound there, a press never ended.
    onMount(() => element && bind(element));
    return {
      ref: (el: HTMLElement) => {
        element = el;
      },
      onKeyDown: (event: KeyboardEvent) => keydown(event, key, event.currentTarget),
    };
  };

  return { moving, over, refused, item, stop: () => stop?.() };
}
