import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { useUiMessages } from "../intl/messages";
import { createDragOnto, type DropTarget, HOVER_OPEN_MS } from "./behavior/dnd";
import { announceText } from "./behavior/treegrid";
import { Icon } from "./marks";
import { PageLayer } from "./page-layer";

// ── Moving onto folders ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Rows, tiles and places that are dragged onto folders, such as files onto a folder of Files. The same `scope` joins
 * a table, tiles and the sidebar's tree: an entry of one is let go over a folder of another. Dragging is a shortcut;
 * the entry's menu ("Verschieben nach …") stays the way for keys and touch. Nothing changes before the drop.
 *
 * What a drag carries is fixed when it is lifted: the entry, or the whole selection when the entry is selected. A
 * folder takes it only when every entry in it may be dragged, none of them is the folder itself or a folder the folder
 * lies in (lists that show levels, a tree, know that), and `accepts` agrees; that is asked again when it is let go.
 */
export type DragMove = {
  /** Lists of one scope take each other's entries, such as `"files"` for the table and the folder tree. */
  scope: string;
  /** The name of an entry or a folder, for the copy under the pointer and for screen readers. */
  label: (key: string) => string;
  /** Whether an entry can be dragged; every one when left out. A selection with one that cannot moves nothing. */
  draggable?: (key: string) => boolean;
  /** Whether an entry is a folder that takes others; none when left out. */
  target?: (key: string) => boolean;
  /**
   * Whether `keys` may go into `target`, for what only the app knows: the person's rights, the kind of the entries, or
   * a folder inside a dragged one at a level no list shows. Asked while dragging and again at the drop.
   */
  accepts?: (keys: readonly string[], target: string) => boolean;
  /** Let go over a folder that takes them: move `keys` into `target`. */
  onDrop?: (keys: readonly string[], target: string) => void;
  /** Files from the computer let go over a folder; a folder from the computer is refused and named so. */
  onFiles?: (files: readonly File[], target: string) => void;
};

type Region = {
  targets: () => DropTarget[];
  /** The elements of this list's entries, by key: only these are its targets. */
  elements: Map<HTMLElement, string>;
  open?: (target: string) => void;
  /** Whether `target` lies inside `key`, at a level this list shows. */
  within?: (target: string, key: string) => boolean;
};

/** The lists of each scope on the page, and the drag under way. Only ever filled in the browser. */
const regions = new Map<string, Set<Region>>();
const [active, setActive] = createSignal<{ scope: string; keys: readonly string[]; over: string | null; refused: string | null } | null>(
  null,
);
const [fileOver, setFileOver] = createSignal<string | null>(null);
const [fileRefused, setFileRefused] = createSignal<string | null>(null);

const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;
/** Whether the computer hands over a folder: the browser says so only on the drop, through the item's entry. */
const holdsFolder = (event: DragEvent) =>
  [...(event.dataTransfer?.items ?? [])].some((item) => item.kind === "file" && item.webkitGetAsEntry?.()?.isDirectory === true);

/**
 * The drag of one list (internal to `Table`, `Tiles` and `Nav`): its targets join the scope, its entries drag.
 * `selected` is the list's selection, which a dragged selected entry takes along; `open` opens a closed folder a
 * pointer rests on; `within` says whether a folder lies inside another at the levels the list shows.
 */
export const useDragMove = (
  drag: () => DragMove | undefined,
  list: {
    targets: () => readonly string[];
    selected?: () => readonly string[];
    open?: (target: string) => void;
    within?: (target: string, key: string) => boolean;
  },
) => {
  const t = useUiMessages();
  const region: Region = {
    targets: () => {
      const given = drag();
      return given ? list.targets().map((id) => ({ id, label: given.label(id) })) : [];
    },
    elements: new Map(),
    open: list.open,
    within: list.within,
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
  const scoped = () => [...(regions.get(drag()?.scope ?? "") ?? [])];
  const selectionOf = (key: string) => {
    const selected = list.selected?.() ?? [];
    return selected.includes(key) ? selected : [key];
  };
  // what the drag under way carries, fixed when it was lifted
  let lifted: readonly string[] | undefined;
  const carried = (key: string) => lifted ?? selectionOf(key);
  const takes = (keys: readonly string[], target: string) => {
    const given = drag();
    if (!given || keys.includes(target)) return false;
    if (keys.some((key) => given.draggable?.(key) === false)) return false;
    if (scoped().some((other) => keys.some((key) => other.within?.(target, key)))) return false;
    return given.accepts?.(keys, target) ?? true;
  };
  const onto = createDragOnto({
    targets: () => scoped().flatMap((other) => other.targets()),
    // each list's elements count only for that list's own targets: an entry that is no folder there never takes a drop,
    // also when its key is a folder in another list of the scope
    targetElements: () =>
      scoped().flatMap((other) => {
        const own = new Set(other.targets().map((target) => target.id));
        return [...other.elements].filter(([, id]) => own.has(id));
      }),
    itemLabel: (key) => {
      const keys = carried(key);
      return keys.length > 1 ? t().entries({ count: keys.length }) : (drag()?.label(key) ?? key);
    },
    accepts: (key, target) => takes(carried(key), target),
    onLift: (key) => {
      // a copy: the app may change its selection array in place while the drag is under way
      lifted = [...selectionOf(key)];
    },
    onDrop: (key, target) => drag()?.onDrop?.(carried(key), target),
    touch: false,
    preview: (key, item, point) => {
      // a small chip with the name (or how many) under the pointer, never a copy of a whole row
      const chip = document.createElement("div");
      chip.className = "k2-ui k2-drag-chip";
      const keys = carried(key);
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
      setActive({ scope, keys: carried(key), over: onto.over(), refused: onto.refused() });
    } else if (started) {
      started = false;
      setActive(null);
      // the drop is handed over right after the drag ends; what it carried is forgotten after that
      queueMicrotask(() => {
        if (!onto.moving()) lifted = undefined;
      });
    }
  });

  let resting: ReturnType<typeof setTimeout> | undefined;
  let refusing: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearTimeout(resting);
    clearTimeout(refusing);
  });
  const mine = () => {
    const now = active();
    return now && now.scope === drag()?.scope ? now : undefined;
  };
  /**
   * An entry's element, made where the entry renders (its bindings end with it): `attrs` (getters, so they follow the
   * drag) and `ref`, which binds the drag and makes the element this list's target for its key.
   */
  const entry = (key: string) => {
    const given = drag();
    const bind = given && (given.draggable?.(key) ?? true) ? onto.item(key) : undefined;
    const isTarget = () => drag()?.target?.(key) ?? false;
    const files = (event: DragEvent) => isTarget() && drag()?.onFiles !== undefined && hasFiles(event);
    const attrs = {
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
        return isTarget() && (mine()?.refused === key || fileRefused() === key) ? "" : undefined;
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
        // a folder from the computer is refused whole, and the folder says so for a moment
        if (holdsFolder(event)) {
          setFileRefused(key);
          announceText(t().dropFoldersRefused);
          clearTimeout(refusing);
          refusing = setTimeout(() => fileRefused() === key && setFileRefused(null), 2500);
          return;
        }
        const dropped = [...(event.dataTransfer?.files ?? [])];
        if (dropped.length > 0) drag()?.onFiles?.(dropped, key);
      },
    };
    const ref = (element: HTMLElement) => {
      bind?.ref(element);
      region.elements.set(element, key);
      onCleanup(() => region.elements.delete(element));
    };
    return { attrs, ref };
  };

  /**
   * While a pointer drags from this list: a labelled place where letting go changes nothing (guide, 3.11.). It lies
   * above everything, so a folder under it never takes the drop (`data-drop-none`).
   */
  const zone = () => (
    <Show when={onto.moving()}>
      <PageLayer from={() => undefined}>
        <div class="k2-ui k2-drag-zone" role="presentation" data-drop-none="">
          <Icon name="hand-stop" />
          {t().dropNothing}
        </div>
      </PageLayer>
    </Show>
  );

  return { entry, zone, moving: onto.moving };
};
