import { createComponent, createEffect, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { activeDrag, announce, type DragPayload, onDragEnd, onPointerPress } from "./drag-and-drop";
import { useDragAndDropMessages } from "./drag-and-drop-messages";
import { preloadWhenIdle } from "./preload-when-idle";

/** One place to drop on, in a level of a `DropOverlay`. */
export type DropOverlayTile = {
  /** Stable within its level. */
  id: string;
  label: string;
  /** A short second line, such as "Others stay responsible". */
  description?: string;
  /** Tabler class, such as "ti ti-folder". */
  icon?: string;
  /** Drawn in place of the icon, such as a person's avatar. */
  leading?: JSX.Element;
  /** The tile takes nothing now, and this says why, such as "Already here"; it is shown in place of `description`. */
  disabled?: string;
  /** Resting on the tile opens this level; "Back" returns. */
  opens?: string;
  /** Runs when the item is dropped on the tile. Without it, the tile only opens its level. */
  onDrop?: (payload: DragPayload) => void;
};

export type DropOverlayLevel = {
  /** Names the level above its tiles, such as "Move to folder · Recently used"; the first level needs none. */
  title?: string;
  tiles: readonly DropOverlayTile[];
};

export type DropOverlayProps = {
  /** The payload types the overlay takes; it shows while such an item is dragged. */
  accept: readonly string[];
  /** The tiles of a level for the dragged item; the overlay starts with "root". */
  level: (id: string, payload: DragPayload) => DropOverlayLevel;
  /** Added to the help line, such as "Folders on the left work too". */
  hint?: string;
  /**
   * A drag of an item the overlay takes ended without a drop: Escape, leaving the window, letting go on the
   * "nothing happens" area or outside every target. The host shows its note, such as "Cancelled, nothing changed".
   */
  onCancel?: (payload: DragPayload) => void;
  class?: string;
};

type View = typeof import("./drop-overlay-view");
let view: View | undefined;
let loading: Promise<View> | undefined;
const load = () => {
  loading ??= import("./drop-overlay-view").then(
    (module) => (view = module),
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  );
  return loading;
};

/**
 * Drop targets that cover the host's main area while an item it takes is dragged: levels of large tiles, resting on a
 * tile opens the next level, and an area where letting go changes nothing. Place it in a positioned box over the list
 * it serves; it takes no space and moves nothing. The overlay is for the pointer; give every target a menu entry too.
 * Its code loads while the page is idle and on every press of a drag source, so the first drag shows it at once.
 */
export function DropOverlay(props: DropOverlayProps): JSX.Element {
  const messages = useDragAndDropMessages();
  const [ready, setReady] = createSignal(view);
  let anchor!: HTMLSpanElement;
  /** Loads ahead of a drag; a failure stays quiet here and is tried again on the next press. */
  const preload = () => {
    if (!ready()) load().then(setReady, () => {});
  };
  onMount(() => {
    onCleanup(onPointerPress(preload));
    onCleanup(
      onDragEnd((payload, dropped) => {
        if (!dropped && props.accept.includes(payload.type)) props.onCancel?.(payload);
      }),
    );
    onCleanup(preloadWhenIdle(anchor.ownerDocument.defaultView!, preload));
  });
  const payload = () => {
    const drag = activeDrag();
    return drag && props.accept.includes(drag.type) ? drag : undefined;
  };
  // A drag that starts before the idle load still gets the overlay, a moment later; if it cannot load, the drag says
  // so, and the item's menu still moves it.
  createEffect(() => {
    if (!payload() || ready()) return;
    load().then(setReady, () => {
      if (payload()) announce(anchor, messages().overlayUnavailable);
    });
  });
  return (
    <>
      <span ref={anchor} class="k2b-drop-overlay-anchor" hidden />
      <Show when={ready()}>
        {(module) => (
          <Show when={payload()}>{(dragged) => createComponent(module().DropOverlayView, { overlay: props, payload: dragged })}</Show>
        )}
      </Show>
    </>
  );
}
