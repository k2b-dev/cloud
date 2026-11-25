import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { useUiMessages } from "../intl/messages";
import { createDragOnto, type DropTarget, HOVER_OPEN_MS } from "./behavior/dnd";
import { Icon } from "./marks";
import { PageLayer } from "./page-layer";

// ── Moving onto folders ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Rows, tiles and places that are dragged onto folders, such as files onto a folder of Files. The same `scope` joins
 * a table, tiles and the sidebar's tree: an entry of one is let go over a folder of another. Dragging is a shortcut;
 * the entry's menu ("Verschieben nach …") stays the way for keys and touch. Nothing changes before the drop.
 */
export type DragMove = {
  /** Lists of one scope take each other's entries, such as `"files"` for the table and the folder tree. */
  scope: string;
  /** The name of an entry or a folder, for the copy under the pointer and for screen readers. */
  label: (key: string) => string;
  /** Whether an entry can be dragged; every one when left out. */
  draggable?: (key: string) => boolean;
  /** Whether an entry is a folder that takes others; none when left out. */
  target?: (key: string) => boolean;
  /** Whether `keys` may go into `target`, such as no folder into itself; any but the dragged themselves when left out. */
  accepts?: (keys: readonly string[], target: string) => boolean;
  /** Let go over a folder: move `keys` into `target`. A dragged entry that is selected takes the whole selection. */
  onDrop?: (keys: readonly string[], target: string) => void;
  /** Files from the computer let go over a folder. */
  onFiles?: (files: readonly File[], target: string) => void;
};

type Region = { targets: () => DropTarget[]; open?: (target: string) => void };

/** The lists of each scope on the page, and the drag under way. Only ever filled in the browser. */
const regions = new Map<string, Set<Region>>();
const [active, setActive] = createSignal<{ scope: string; keys: readonly string[]; over: string | null; refused: string | null } | null>(
  null,
);
const [fileOver, setFileOver] = createSignal<string | null>(null);

const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;

/**
 * The drag of one list (internal to `Table`, `Tiles` and `Nav`): its targets join the scope, its entries drag.
 * `selected` is the list's selection, which a dragged selected entry takes along; `open` opens a closed folder a
 * pointer rests on.
 */
export const useDragMove = (
  drag: () => DragMove | undefined,
  list: { targets: () => readonly string[]; selected?: () => readonly string[]; open?: (target: string) => void },
) => {
  const t = useUiMessages();
  const region: Region = {
    targets: () => {
      const given = drag();
      return given ? list.targets().map((id) => ({ id, label: given.label(id) })) : [];
    },
    open: list.open,
  };
  if (!isServer) {
    createEffect(() => {
      const scope = drag()?.scope;
      if (!scope) return;
      const set = regions.get(scope) ?? new Set();
      regions.set(scope, set);
      set.add(region);
      onCleanup(() => set.delete(region));
    });
  }
  const keysOf = (key: string) => {
    const selected = list.selected?.() ?? [];
    return selected.includes(key) ? selected : [key];
  };
  const scoped = () => [...(regions.get(drag()?.scope ?? "") ?? [])];
  const onto = createDragOnto({
    targets: () => scoped().flatMap((other) => other.targets()),
    itemLabel: (key) => {
      const keys = keysOf(key);
      return keys.length > 1 ? t().entries({ count: keys.length }) : (drag()?.label(key) ?? key);
    },
    accepts: (key, target) => {
      const keys = keysOf(key);
      if (keys.includes(target)) return false;
      return drag()?.accepts?.(keys, target) ?? true;
    },
    onDrop: (key, target) => drag()?.onDrop?.(keysOf(key), target),
    touch: false,
    preview: (key, item, point) => {
      // a small chip with the name (or how many) under the pointer, never a copy of a whole row
      const chip = document.createElement("div");
      chip.className = "k2-ui k2-drag-chip";
      const keys = keysOf(key);
      chip.textContent = keys.length > 1 ? t().entries({ count: keys.length }) : (drag()?.label(key) ?? key);
      Object.assign(chip.style, { position: "fixed", left: `${point.x}px`, top: `${point.y}px` });
      (item.closest(".k2-ui") ?? document.body).append(chip);
      return chip;
    },
    onRest: (target) =>
      scoped()
        .find((other) => other.targets().some((entry) => entry.id === target))
        ?.open?.(target),
  });
  // the drag under way, for every list of the scope; only the list it started from sets and clears it
  let started = false;
  createEffect(() => {
    const key = onto.moving();
    const scope = drag()?.scope;
    if (key && scope) {
      started = true;
      setActive({ scope, keys: keysOf(key), over: onto.over(), refused: onto.refused() });
    } else if (started) {
      started = false;
      setActive(null);
    }
  });

  let resting: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(resting));
  const mine = () => {
    const now = active();
    return now && now.scope === drag()?.scope ? now : undefined;
  };
  /**
   * Props for an entry's element, made where the entry renders (its bindings end with it): it drags when allowed and,
   * as a folder, takes drops and files. The attributes are getters, so they follow the drag.
   */
  const entry = (key: string) => {
    const given = drag();
    const bind = given && (given.draggable?.(key) ?? true) ? onto.item(key) : undefined;
    const isTarget = () => drag()?.target?.(key) ?? false;
    const files = (event: DragEvent) => isTarget() && drag()?.onFiles !== undefined && hasFiles(event);
    return {
      ref: (element: HTMLElement) => bind?.ref(element),
      get "data-dragging"() {
        return mine()?.keys.includes(key) ? "" : undefined;
      },
      get "data-drop-target"() {
        return isTarget() ? key : undefined;
      },
      get "data-drop-over"() {
        return isTarget() && (mine()?.over === key || fileOver() === key) ? "" : undefined;
      },
      get "data-drop-refused"() {
        return isTarget() && mine()?.refused === key ? "" : undefined;
      },
      onDragOver: (event: DragEvent) => {
        if (!files(event)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        if (fileOver() === key) return;
        setFileOver(key);
        clearTimeout(resting);
        resting = setTimeout(() => fileOver() === key && list.open?.(key), HOVER_OPEN_MS);
      },
      onDragLeave: (event: DragEvent) => {
        const from = event.currentTarget;
        if (from instanceof Node && event.relatedTarget instanceof Node && from.contains(event.relatedTarget)) return;
        if (fileOver() === key) setFileOver(null);
      },
      onDrop: (event: DragEvent) => {
        if (!files(event)) return;
        event.preventDefault();
        setFileOver(null);
        clearTimeout(resting);
        const dropped = [...(event.dataTransfer?.files ?? [])];
        if (dropped.length > 0) drag()?.onFiles?.(dropped, key);
      },
    };
  };

  /** While a pointer drags from this list: a labelled place where letting go changes nothing (guide, 3.11.). */
  const zone = () => (
    <Show when={onto.moving()}>
      <PageLayer from={() => undefined}>
        <div class="k2-ui k2-drag-zone" role="presentation">
          <Icon name="hand-stop" />
          {t().dropNothing}
        </div>
      </PageLayer>
    </Show>
  );

  return { entry, zone, moving: onto.moving };
};
