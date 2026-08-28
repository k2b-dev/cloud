import { useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { renderMarkupCanvas } from "./markup";
import { imageProcessorMessages } from "./messages";
import {
  findMarkupAtPoint,
  type MarkupResizeHandle,
  markupBounds,
  markupElementsEqual,
  markupHandles,
  resizeMarkupElement,
  strokeIdsAtPoint,
  translateMarkupElementInCanvas,
} from "./markup-interaction";
import type { MarkupElement, MarkupPoint, MarkupShapeKind, MarkupTool } from "./types";

type MarkupOverlayProps = {
  imageId: string;
  width: number;
  height: number;
  elements: MarkupElement[];
  active: boolean;
  tool: MarkupTool;
  shape: MarkupShapeKind;
  color: string;
  size: number;
  selectedId: string | null;
  onCommit: (elements: MarkupElement[], imageId: string) => void;
  onSelect: (elementId: string | null, imageId: string) => void;
  onText: (position: MarkupPoint, imageId: string) => void;
};

type DrawGesture = { type: "draw"; pointerId: number; element: MarkupElement };
type MoveGesture = {
  type: "move";
  pointerId: number;
  elementId: string;
  start: MarkupPoint;
  original: MarkupElement;
  current: MarkupElement;
  changed: boolean;
};
type ResizeGesture = {
  type: "resize";
  pointerId: number;
  elementId: string;
  handle: MarkupResizeHandle;
  start: MarkupPoint;
  original: MarkupElement;
  current: MarkupElement;
  changed: boolean;
};
type EraseGesture = { type: "erase"; pointerId: number; erasedIds: Set<string>; last: MarkupPoint };
type Gesture = DrawGesture | MoveGesture | ResizeGesture | EraseGesture;

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const pointerSamples = (event: PointerEvent) => {
  const samples = event.getCoalescedEvents?.();
  return samples && samples.length > 0 ? samples : [event];
};

export default function MarkupOverlay(props: MarkupOverlayProps) {
  const locale = useLocale();
  const t = () => imageProcessorMessages.resolve([locale()]).t;
  const [draftElements, setDraftElements] = createSignal<MarkupElement[]>([]);
  const [hiddenIds, setHiddenIds] = createSignal<ReadonlySet<string>>(new Set<string>());
  let committedCanvas: HTMLCanvasElement | undefined;
  let interactionCanvas: HTMLCanvasElement | undefined;
  let gesture: Gesture | null = null;
  let frame: number | null = null;
  let pendingDraftElements: MarkupElement[] = [];
  let renderedImageId = props.imageId;
  let renderedElements = props.elements;

  const draw = (canvas: HTMLCanvasElement | undefined, elements: MarkupElement[]) => {
    if (!canvas || props.width <= 0 || props.height <= 0) return;
    if (canvas.width !== props.width) canvas.width = props.width;
    if (canvas.height !== props.height) canvas.height = props.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    renderMarkupCanvas(context, elements, canvas.width, canvas.height);
  };

  const visibleElements = createMemo(() => {
    const hidden = hiddenIds();
    return hidden.size === 0 ? props.elements : props.elements.filter((element) => !hidden.has(element.id));
  });

  createEffect(() => draw(committedCanvas, visibleElements()));
  createEffect(() => draw(interactionCanvas, draftElements()));

  const resetGesture = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    gesture = null;
    pendingDraftElements = [];
    setDraftElements([]);
    setHiddenIds(new Set<string>());
  };

  createEffect(() => {
    if (props.active) return;
    resetGesture();
  });
  createEffect(() => {
    const nextImageId = props.imageId;
    if (nextImageId === renderedImageId) return;
    renderedImageId = nextImageId;
    resetGesture();
  });
  createEffect(() => {
    const nextElements = props.elements;
    if (nextElements === renderedElements) return;
    renderedElements = nextElements;
    if (gesture) resetGesture();
  });

  const scheduleDraft = (elements: MarkupElement[]) => {
    pendingDraftElements = elements;
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      setDraftElements([...pendingDraftElements]);
    });
  };

  const canvasRect = () => interactionCanvas?.getBoundingClientRect() ?? null;

  const pointDistanceOnCanvas = (start: MarkupPoint, end: MarkupPoint) => {
    const rect = canvasRect();
    return Math.hypot((end.x - start.x) * (rect?.width ?? 1), (end.y - start.y) * (rect?.height ?? 1));
  };
  const movedEnough = (start: MarkupPoint, end: MarkupPoint) => pointDistanceOnCanvas(start, end) >= 2;

  const pointFromEvent = (event: PointerEvent): MarkupPoint => {
    const rect = canvasRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
  };

  const beginPointer = (event: PointerEvent) => {
    if (!props.active || gesture || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return false;
    event.preventDefault();
    return true;
  };

  const createDrawElement = (position: MarkupPoint): MarkupElement => {
    const id = crypto.randomUUID();
    if (props.tool === "pen" || props.tool === "highlighter") {
      return {
        id,
        kind: "stroke",
        points: [position],
        color: props.color,
        size: props.size,
        opacity: props.tool === "highlighter" ? 0.35 : 1,
      };
    }
    if (props.tool === "redact") return { id, kind: "redaction", start: position, end: position, color: "#000000" };
    return { id, kind: "shape", shape: props.shape, start: position, end: position, color: props.color, size: props.size };
  };

  const collectErasedStrokes = (current: EraseGesture, position: MarkupPoint) => {
    const rect = canvasRect();
    if (!rect) return false;
    const previousSize = current.erasedIds.size;
    const distance = Math.hypot((position.x - current.last.x) * rect.width, (position.y - current.last.y) * rect.height);
    const steps = Math.max(1, Math.ceil(distance / 8));
    for (let step = 1; step <= steps; step++) {
      const progress = step / steps;
      const sample = {
        x: current.last.x + (position.x - current.last.x) * progress,
        y: current.last.y + (position.y - current.last.y) * progress,
      };
      for (const id of strokeIdsAtPoint(props.elements, sample, rect.width, rect.height)) current.erasedIds.add(id);
    }
    current.last = position;
    return current.erasedIds.size !== previousSize;
  };

  const startGesture = (event: PointerEvent) => {
    if (!beginPointer(event)) return;
    interactionCanvas?.focus({ preventScroll: true });
    const position = pointFromEvent(event);
    const rect = canvasRect();
    if (!rect) return;

    if (props.tool === "text") {
      props.onText(position, props.imageId);
      return;
    }

    if (props.tool === "select") {
      const element = findMarkupAtPoint(props.elements, position, rect.width, rect.height);
      props.onSelect(element?.id ?? null, props.imageId);
      if (!element) return;
      gesture = {
        type: "move",
        pointerId: event.pointerId,
        elementId: element.id,
        start: position,
        original: element,
        current: element,
        changed: false,
      };
      setHiddenIds(new Set([element.id]));
      setDraftElements([element]);
    } else if (props.tool === "eraser") {
      const current: EraseGesture = { type: "erase", pointerId: event.pointerId, erasedIds: new Set<string>(), last: position };
      gesture = current;
      if (collectErasedStrokes(current, position)) setHiddenIds(new Set(current.erasedIds));
    } else {
      const element = createDrawElement(position);
      gesture = { type: "draw", pointerId: event.pointerId, element };
      setDraftElements([element]);
    }
    interactionCanvas?.setPointerCapture(event.pointerId);
  };

  const startResize = (handle: MarkupResizeHandle, event: PointerEvent) => {
    if (!beginPointer(event) || props.tool !== "select" || !props.selectedId) return;
    event.stopPropagation();
    interactionCanvas?.focus({ preventScroll: true });
    const element = props.elements.find((entry) => entry.id === props.selectedId);
    if (!element) return;
    gesture = {
      type: "resize",
      pointerId: event.pointerId,
      elementId: element.id,
      handle,
      start: pointFromEvent(event),
      original: element,
      current: element,
      changed: false,
    };
    setHiddenIds(new Set([element.id]));
    setDraftElements([element]);
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveGesture = (event: PointerEvent) => {
    const current = gesture;
    if (!current || event.pointerId !== current.pointerId) return;
    event.preventDefault();

    if (current.type === "draw") {
      if (current.element.kind === "stroke") {
        const points = current.element.points;
        for (const nextEvent of pointerSamples(event)) {
          const point = pointFromEvent(nextEvent);
          const previous = points.at(-1);
          if (!previous || pointDistanceOnCanvas(previous, point) >= 1.5) points.push(point);
        }
      } else if (current.element.kind === "redaction" || current.element.kind === "shape") {
        current.element = { ...current.element, end: pointFromEvent(event) };
      }
      scheduleDraft([current.element]);
      return;
    }

    if (current.type === "erase") {
      let changed = false;
      for (const nextEvent of pointerSamples(event)) changed = collectErasedStrokes(current, pointFromEvent(nextEvent)) || changed;
      if (changed) setHiddenIds(new Set(current.erasedIds));
      return;
    }

    if (current.type === "move") {
      const position = pointFromEvent(event);
      const delta = { x: position.x - current.start.x, y: position.y - current.start.y };
      const rect = canvasRect();
      current.current = rect ? translateMarkupElementInCanvas(current.original, delta, rect.width, rect.height) : current.original;
      current.changed = current.changed || movedEnough(current.start, position);
      scheduleDraft([current.current]);
      return;
    }

    const rect = canvasRect();
    if (!rect) return;
    const position = pointFromEvent(event);
    current.current = resizeMarkupElement(current.original, current.handle, position, rect.width, rect.height);
    current.changed = current.changed || movedEnough(current.start, position);
    scheduleDraft([current.current]);
  };

  const finishGesture = (event: PointerEvent, commit: boolean) => {
    const current = gesture;
    if (!current || event.pointerId !== current.pointerId) return;
    event.preventDefault();

    if (commit && current.type === "draw") {
      const position = pointFromEvent(event);
      if (current.element.kind === "stroke") {
        const previous = current.element.points.at(-1);
        if (!previous || pointDistanceOnCanvas(previous, position) >= 1.5) current.element.points.push(position);
      } else if (current.element.kind === "redaction" || current.element.kind === "shape") {
        current.element = { ...current.element, end: position };
      }
    } else if (commit) {
      moveGesture(event);
    }

    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    pendingDraftElements = [];
    gesture = null;

    if (!commit) {
      setDraftElements([]);
      setHiddenIds(new Set<string>());
      return;
    }

    let nextElements: MarkupElement[] | null = null;
    let selectedId: string | null = props.selectedId;
    if (current.type === "draw") {
      if (
        (current.element.kind === "redaction" || current.element.kind === "shape") &&
        !movedEnough(current.element.start, current.element.end)
      ) {
        setDraftElements([]);
        setHiddenIds(new Set<string>());
        return;
      }
      nextElements = [...props.elements, current.element];
      selectedId = current.element.id;
    } else if (current.type === "erase") {
      if (current.erasedIds.size > 0) {
        nextElements = props.elements.filter((element) => !current.erasedIds.has(element.id));
        if (selectedId && current.erasedIds.has(selectedId)) selectedId = null;
      }
    } else if (current.changed && !markupElementsEqual(current.original, current.current)) {
      nextElements = props.elements.map((element) => (element.id === current.elementId ? current.current : element));
      selectedId = current.elementId;
    }

    setDraftElements([]);
    if (nextElements) {
      draw(committedCanvas, nextElements);
      props.onCommit(nextElements, renderedImageId);
    }
    setHiddenIds(new Set<string>());
    props.onSelect(selectedId, renderedImageId);
  };

  const commitPointer = (event: PointerEvent) => finishGesture(event, true);
  const cancelPointer = (event: PointerEvent) => finishGesture(event, false);
  const cancelOnVisibilityChange = () => {
    if (document.hidden) resetGesture();
  };

  onMount(() => {
    document.addEventListener("pointermove", moveGesture, { passive: false });
    document.addEventListener("pointerup", commitPointer);
    document.addEventListener("pointercancel", cancelPointer);
    document.addEventListener("visibilitychange", cancelOnVisibilityChange);
    window.addEventListener("blur", resetGesture);

    onCleanup(() => {
      document.removeEventListener("pointermove", moveGesture);
      document.removeEventListener("pointerup", commitPointer);
      document.removeEventListener("pointercancel", cancelPointer);
      document.removeEventListener("visibilitychange", cancelOnVisibilityChange);
      window.removeEventListener("blur", resetGesture);
    });
  });

  onCleanup(() => {
    if (frame !== null) cancelAnimationFrame(frame);
  });

  const selectedElement = createMemo(() => {
    if (!props.selectedId) return null;
    return (
      draftElements().find((element) => element.id === props.selectedId) ??
      props.elements.find((element) => element.id === props.selectedId) ??
      null
    );
  });

  const selectionBounds = createMemo(() => {
    const element = selectedElement();
    return element ? markupBounds(element, props.width, props.height) : null;
  });

  const selectionHandles = createMemo(() => {
    const element = selectedElement();
    return element ? markupHandles(element, props.width, props.height) : [];
  });

  return (
    <div class="pointer-events-none absolute inset-0">
      <canvas ref={committedCanvas} class="absolute inset-0 h-full w-full" aria-hidden="true" />
      <canvas
        ref={interactionCanvas}
        class="absolute inset-0 h-full w-full touch-none"
        classList={{
          "pointer-events-auto cursor-default": props.active && props.tool === "select",
          "pointer-events-auto cursor-cell": props.active && props.tool === "eraser",
          "pointer-events-auto cursor-crosshair": props.active && props.tool !== "select" && props.tool !== "eraser",
          "pointer-events-none": !props.active,
        }}
        aria-label={props.active ? t().markupCanvas : undefined}
        tabIndex={-1}
        onPointerDown={startGesture}
        onLostPointerCapture={resetGesture}
      />

      <Show when={props.active && props.tool === "select" && selectionBounds()}>
        {(bounds) => (
          <div
            class="absolute border border-blue-500 pointer-events-none"
            style={{
              left: `${bounds().x * 100}%`,
              top: `${bounds().y * 100}%`,
              width: `${bounds().w * 100}%`,
              height: `${bounds().h * 100}%`,
            }}
          >
            <For each={selectionHandles()}>
              {(handle) => (
                <button
                  type="button"
                  class="pointer-events-auto absolute flex h-6 w-6 items-center justify-center"
                  style={{
                    left: `${((handle.point.x - bounds().x) / Math.max(bounds().w, 0.0001)) * 100}%`,
                    top: `${((handle.point.y - bounds().y) / Math.max(bounds().h, 0.0001)) * 100}%`,
                    transform: "translate(-50%, -50%)",
                    cursor: handle.cursor,
                  }}
                  aria-label={t()[handle.label]}
                  onPointerDown={(event) => startResize(handle.id, event)}
                  onLostPointerCapture={resetGesture}
                >
                  <span class="h-3 w-3 rounded-full border border-white bg-blue-500 shadow-sm" aria-hidden="true" />
                </button>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
}
