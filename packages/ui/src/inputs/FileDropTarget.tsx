import { createEffect, createMemo, createSignal, type JSX, onCleanup, onMount } from "solid-js";
import { useLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import { FILE_DROP_DEFAULT_REGION, type FileDropOptions, type FileDropTargetEntry, fileDropEngine, liveDocument } from "./file-drop";

export type { FileDropDetails, FileDropOptions, FileDropRejection } from "./file-drop";

export type FileDropTargetProps = FileDropOptions & {
  /**
   * The area that takes the files. Defaults to the nearest dialog, `AppWorkspace.Detail`, or `AppWorkspace.Main`
   * around the component, and to the whole window outside of them.
   */
  for?: Element;
};

type Rect = { top: number; left: number; width: number; height: number; radius: string };

/**
 * Turns an area into a drop target while files from outside the page are dragged over the window. A calm overlay
 * covers the area without moving anything and says what dropping does; a more specific target inside it, such as a
 * folder row or a `FileDropzone`, takes the drop and its sentence while the pointer is over it. Text, links, and
 * elements dragged within the page never show it. Keep a visible upload button for keyboard and touch users.
 */
export function FileDropTarget(props: FileDropTargetProps): JSX.Element {
  const messages = useUiMessages();
  const locale = useLocale();
  let overlay: HTMLDivElement | undefined;
  const [rect, setRect] = createSignal<Rect>();
  const region = () => props.for ?? overlay?.parentElement?.closest(FILE_DROP_DEFAULT_REGION) ?? overlay?.ownerDocument.documentElement;
  const entry: FileDropTargetEntry = { options: props, messages, locale, region };
  const [engine, setEngine] = createSignal<ReturnType<typeof fileDropEngine>>();

  onMount(() => {
    if (!overlay) return;
    const drop = fileDropEngine(liveDocument(overlay));
    onCleanup(drop.addRegion(entry));
    setEngine(drop);
  });

  const shown = createMemo(() => engine()?.session()?.shown.includes(entry) ?? false);
  const hover = createMemo(() => {
    const current = engine()?.session()?.hover;
    const element = region();
    return current && element && (current.element === element || element.contains(current.element)) ? current : null;
  });
  const state = () => (hover() ? (hover()!.invalid ? "invalid" : "over") : "available");
  const sentence = () => {
    const current = hover();
    if (current?.invalid) return messages().fileTypeNotAccepted;
    return current ? current.entry.options.label : props.label;
  };

  createEffect(() => {
    if (!shown()) return;
    engine()?.frame();
    const element = region();
    const view = overlay?.ownerDocument.defaultView;
    if (!element || !view) return;
    // The overlay keeps to the visible part of its area, so its sentence stays on screen.
    const bounds =
      element === element.ownerDocument.documentElement
        ? new DOMRect(0, 0, view.innerWidth, view.innerHeight)
        : element.getBoundingClientRect();
    const top = Math.max(0, bounds.top);
    const left = Math.max(0, bounds.left);
    const next = {
      top,
      left,
      width: Math.max(0, Math.min(view.innerWidth, bounds.right) - left),
      height: Math.max(0, Math.min(view.innerHeight, bounds.bottom) - top),
      radius: view.getComputedStyle(element).borderRadius,
    };
    const previous = rect();
    if (
      !previous ||
      previous.top !== next.top ||
      previous.left !== next.left ||
      previous.width !== next.width ||
      previous.height !== next.height ||
      previous.radius !== next.radius
    )
      setRect(next);
  });

  createEffect(() => {
    if (!overlay?.showPopover) return;
    const open = overlay.matches(":popover-open");
    if (shown() && !open) overlay.showPopover();
    else if (!shown() && open) overlay.hidePopover();
  });
  onCleanup(() => {
    if (overlay?.matches?.(":popover-open")) overlay.hidePopover();
  });

  return (
    <div
      ref={overlay}
      popover="manual"
      class="k2b-file-drop"
      data-state={state()}
      aria-hidden="true"
      style={
        rect()
          ? {
              top: `${rect()!.top}px`,
              left: `${rect()!.left}px`,
              width: `${rect()!.width}px`,
              height: `${rect()!.height}px`,
              "border-radius": rect()!.radius,
            }
          : undefined
      }
    >
      <span class="k2b-file-drop__message">
        <i class={state() === "invalid" ? "ti ti-file-x" : "ti ti-upload"} />
        <span>{sentence()}</span>
      </span>
    </div>
  );
}

/**
 * Makes one element a specific drop target, such as a folder row inside a `FileDropTarget` area: pass the result as
 * the element's `ref`. It wins over the area around it while the pointer is over it, and the area's overlay shows its
 * sentence. Calling the ref again with new options replaces them.
 */
export function fileDropTarget(options: FileDropOptions): (element: Element) => void {
  const messages = useUiMessages();
  const locale = useLocale();
  return (element) => {
    const entry = { options, messages, locale };
    // A ref runs before its element is inserted; registering after insertion finds the document it ends up in.
    queueMicrotask(() => fileDropEngine(liveDocument(element)).setTarget(element, entry));
  };
}
