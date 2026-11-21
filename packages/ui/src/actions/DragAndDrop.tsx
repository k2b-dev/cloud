import { createEffect, type JSX, onCleanup, onMount } from "solid-js";
import { useLocale } from "../intl/locale";
import { announce, bindDragSource, type DragPayload, registerDropTarget } from "./drag-and-drop";
import { useDragAndDropMessages } from "./drag-and-drop-messages";

export type { DragPayload, DragStatus } from "./drag-and-drop";
export { activeDrag, dragStatus } from "./drag-and-drop";

export type DragSourceProps<Type extends string = string> = {
  /** Read when the drag starts, so a selection can decide what is dragged. */
  payload: DragPayload<Type>;
  disabled?: boolean;
  /** How far the mouse or pen moves before the drag starts, in px; 10 by default, 6 for a `DropOverlay` (S7). */
  threshold?: number;
  /**
   * "none": a finger never drags this source, so a long press stays with the host, such as the menu of a
   * `GestureMenu`; the mouse and a pen still drag. "drag" (default): a held finger drags.
   */
  touch?: "drag" | "none";
  /**
   * With `touch: "none"`: a finger held 500 ms, moving at most 8 px, calls this instead of dragging, so the host opens
   * the row's menu there (S7). The release after it never clicks the row.
   */
  onLongPress?: (point: { x: number; y: number }) => void;
  class?: string;
  children: JSX.Element;
};
export type DropTargetProps<Type extends string = string> = {
  /** The payload types this target takes. */
  accept: readonly Type[];
  /** Names the target in announcements and in the keyboard path, such as "Archive". */
  label: string;
  onDrop: (payload: DragPayload<Type>) => void;
  /** The target takes nothing now, for example without access; it refuses every drop. */
  disabled?: boolean;
  class?: string;
  children: JSX.Element;
};

export function DragSource<Type extends string = string>(props: DragSourceProps<Type>): JSX.Element {
  const messages = useDragAndDropMessages();
  let source!: HTMLDivElement;
  onMount(() =>
    onCleanup(
      bindDragSource(source, () => ({
        payload: props.payload,
        disabled: props.disabled,
        messages: messages(),
        threshold: props.threshold,
        touch: props.touch,
        onLongPress: props.onLongPress,
      })),
    ),
  );
  return (
    <div ref={source} class={`k2b-drag-source${props.class ? ` ${props.class}` : ""}`} data-drag-disabled={props.disabled ? "" : undefined}>
      {props.children}
    </div>
  );
}

export function DropTarget<Type extends string = string>(props: DropTargetProps<Type>): JSX.Element {
  // Resolve the inherited locale in the component's owner, as DragSource and the keyboard hook do.
  const messages = useDragAndDropMessages();
  let element!: HTMLDivElement;
  onMount(() => {
    const read = () => {
      const accept = props.accept;
      const onDrop = props.onDrop;
      return {
        accept,
        label: props.label,
        messages: messages(),
        disabled: props.disabled,
        drop: (payload: DragPayload) => {
          // Only this membership guard narrows the opaque payload type at the registry boundary.
          const type = accept.find((type) => type === payload.type);
          if (type !== undefined) onDrop({ ...payload, type });
        },
      };
    };
    const target = registerDropTarget(element, read());
    createEffect(() => target.update(read()));
    onCleanup(() => target.dispose());
  });
  return (
    <div ref={element} class={`k2b-drop-target${props.class ? ` ${props.class}` : ""}`}>
      {props.children}
    </div>
  );
}

/**
 * Starts the optional keyboard pick-up sequence from a menu entry. Focus returns to `origin` afterwards, or to its
 * nearest focusable ancestor, such as the group of a `GestureMenu`.
 */
export function useKeyboardDrag(): (payload: DragPayload, origin: HTMLElement) => void {
  const messages = useDragAndDropMessages();
  const locale = useLocale();
  let cancel: (() => void) | undefined;
  /** The latest request; a newer one, or cleanup, makes an older one that is still loading start nothing. */
  let request: object | undefined;
  onCleanup(() => {
    request = undefined;
    cancel?.();
  });
  return (payload, origin) => {
    cancel?.();
    cancel = undefined;
    const own = {};
    request = own;
    // Loaded on first use: pages that never pick up by keyboard do not ship the sequence.
    import("./drag-and-drop-keyboard").then(
      ({ startKeyboardDrag }) => {
        if (request === own && origin.isConnected) cancel = startKeyboardDrag(payload, origin, messages(), locale());
      },
      () => announce(origin, messages().unavailable),
    );
  };
}
