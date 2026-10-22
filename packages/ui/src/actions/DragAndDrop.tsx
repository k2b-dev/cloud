import { createEffect, type JSX, onCleanup, onMount } from "solid-js";
import { bindDragSource, type DragPayload, registerDropTarget, startKeyboardDrag } from "./drag-and-drop";
import { useDragAndDropMessages } from "./drag-and-drop-messages";

export type { DragPayload } from "./drag-and-drop";
export { activeDrag } from "./drag-and-drop";

export type DragSourceProps<Type extends string = string> = {
  /** Read when the drag starts, so a selection can decide what is dragged. */
  payload: DragPayload<Type>;
  disabled?: boolean;
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
  onMount(() => onCleanup(bindDragSource(source, () => ({ payload: props.payload, disabled: props.disabled, messages: messages() }))));
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
  let cancel: (() => void) | undefined;
  onCleanup(() => cancel?.());
  return (payload, origin) => {
    cancel?.();
    cancel = startKeyboardDrag(payload, origin, messages());
  };
}
