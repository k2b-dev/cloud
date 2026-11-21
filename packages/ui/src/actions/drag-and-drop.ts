import { createSignal, type Signal } from "solid-js";
import { getK2bPortalRoot } from "../internal/portal";
import { suppressTextSelection } from "../internal/text-selection";
import type { DragAndDropMessages } from "./drag-and-drop-messages";

export type DragPayload<Type extends string = string> = {
  /** What is dragged, such as "mail.message"; targets accept by this. */
  type: Type;
  /** Opaque to @k2b/ui: the application's reference, such as an ID or a ref string. */
  value: string;
  /** Names the item in the preview and in announcements. */
  label: string;
  /** Tabler class for the preview, such as "ti ti-mail". */
  icon?: string;
  /** More than one item is dragged: shown as a count on the preview. */
  count?: number;
};

const SLOP = 10;
const IGNORE = "input, textarea, select, [contenteditable]:not([contenteditable='false']), [data-drag-ignore]";
/** A finger held this long lifts the item; before that it scrolls. Sortable rows lift sooner (K7). */
const HOLD_MS = 500;
const AUTOSCROLL_EDGE = 32;
/**
 * Signals are made on first use, so the module has no side effects and a bundle that imports `@k2b/ui` without drag and
 * drop drops it.
 */
let signals: { drag: Signal<DragPayload | undefined>; status: Signal<DragStatus | undefined> } | undefined;
const shared = () => (signals ??= { drag: createSignal<DragPayload>(), status: createSignal<DragStatus>() });
const readActiveDrag = () => shared().drag[0]();
export const setActiveDrag = (payload: DragPayload | undefined) => shared().drag[1](payload);
/** Reactive payload of the drag in progress, or undefined. */
export const activeDrag = (): DragPayload | undefined => readActiveDrag();

/**
 * What the drag in progress moves and where it goes, in words a status line can show; the same words reach screen
 * readers through the live region. `lead` names what moves, `detail` where it goes and how to cancel.
 */
export type DragStatus = { lead: string; detail: string };
const readDragStatus = () => shared().status[0]();
export const writeDragStatus = (status: DragStatus | undefined) => shared().status[1](status);
/** Reactive status of the drag in progress, for a status line; undefined while nothing is dragged. */
export const dragStatus = (): DragStatus | undefined => readDragStatus();
/** Internal: SortableList states the exact place, which a plain target cannot. */
export const setDragStatus = (status: DragStatus | undefined) => writeDragStatus(status);
const dragStartListeners = new Set<(pointerId: number) => void>();
/** Internal hand-over to the gesture menu that owns this press. */
const endListeners = new Set<(payload: DragPayload, dropped: boolean) => void>();
/** Internal: told when a drag or keyboard pickup ends, and whether something took it; for a host's "nothing changed" note. */
export const onDragEnd = (listener: (payload: DragPayload, dropped: boolean) => void): (() => void) => {
  endListeners.add(listener);
  return () => endListeners.delete(listener);
};
export const notifyDragEnd = (payload: DragPayload, dropped: boolean) => {
  for (const listener of endListeners) listener(payload, dropped);
};
/** S7: a finger held this long on a source that does not drag by touch opens its menu; moving further cancels. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 8;
let shownPreview: HTMLElement | undefined;
/** Internal: the preview of the pointer drag in progress, such as for a drop overlay that shows it compact. */
export const currentPreview = (): HTMLElement | undefined => shownPreview;
const pressListeners = new Set<() => void>();
/** Internal: told about every press on a drag source, before any drag, so code a drag needs can load in time. */
export const onPointerPress = (listener: () => void): (() => void) => {
  pressListeners.add(listener);
  return () => pressListeners.delete(listener);
};
export const onPointerDragStart = (listener: (pointerId: number) => void): (() => void) => {
  dragStartListeners.add(listener);
  return () => dragStartListeners.delete(listener);
};

export type Target = {
  element: HTMLElement;
  accept: readonly string[];
  label: string;
  messages: DragAndDropMessages;
  disabled?: boolean;
  drop: (payload: DragPayload) => void;
  /**
   * Internal: told where the pointer is while it rests over this target, and `undefined` when it leaves. It may
   * return the viewport y of a line it shows, which the preview then keeps clear of.
   */
  hover?: (point: { x: number; y: number } | undefined) => number | undefined;
  /** Internal: letting go here changes nothing, like letting go outside every target; for a "Drop here: nothing happens" area. */
  cancels?: boolean;
};
export type Session = {
  payload: DragPayload;
  origin: HTMLElement;
  cancel: () => void;
  targetsChanged?: () => void;
};
export type Engine = {
  targets: Set<Target>;
  byElement: WeakMap<Element, Target>;
  session?: Session;
  abandonPress?: () => void;
};
const engines = new WeakMap<Document, Engine>();
export const engineFor = (doc: Document): Engine => {
  let engine = engines.get(doc);
  if (!engine) {
    engine = { targets: new Set(), byElement: new WeakMap() };
    engines.set(doc, engine);
  }
  return engine;
};
export const accepts = (target: Target, payload: DragPayload) =>
  target.element.isConnected && !target.disabled && target.accept.includes(payload.type);
export const mark = (target: Target, payload?: DragPayload) => {
  if (payload && accepts(target, payload)) target.element.dataset.drop = "ok";
  else delete target.element.dataset.drop;
};
const containerFor = (origin: HTMLElement): HTMLElement => {
  try {
    return origin.closest<HTMLDialogElement>("dialog[open]:modal") ?? origin.ownerDocument.body;
  } catch {
    return origin.closest<HTMLDialogElement>("dialog[open]") ?? origin.ownerDocument.body;
  }
};
/** A live region needs a moment between being inserted and being written to, or its first text goes unread. */
const ANNOUNCE_DELAY_MS = 100;
type Announcer = { region: HTMLElement; ready: number; queue: string[] };
/** One live region per container: the body, or the modal dialog the drag happens in, as outside of it is inert. */
const announcers = new WeakMap<Element, Announcer>();
const announcerFor = (origin: HTMLElement): Announcer => {
  const parent = containerFor(origin);
  let announcer = announcers.get(parent);
  if (!announcer || announcer.region.parentElement !== parent) {
    const region = origin.ownerDocument.createElement("div");
    region.className = "k2b-drag-announcer";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "true");
    Object.assign(region.style, {
      position: "absolute",
      width: "1px",
      height: "1px",
      clip: "rect(0, 0, 0, 0)",
      overflow: "hidden",
      whiteSpace: "nowrap",
    });
    // First in a dialog: a dialog stack keeps its top level as the dialog's last child, and finds it there.
    if (parent === origin.ownerDocument.body) parent.append(region);
    else parent.prepend(region);
    announcer = { region, ready: performance.now() + ANNOUNCE_DELAY_MS, queue: [] };
    announcers.set(parent, announcer);
  }
  return announcer;
};
/** Speaks through the drag live region of `origin`'s container; SortableList shares it for keyboard moves. */
export const announce = (origin: HTMLElement, text: string) => {
  const announcer = announcerFor(origin);
  const write = (next: string) => {
    announcer.region.textContent = announcer.region.textContent === next ? `${next}\u00a0` : next;
  };
  const wait = announcer.ready - performance.now();
  if (wait <= 0 && !announcer.queue.length) {
    write(text);
    return;
  }
  // Texts that come before the region is ready are read together once it is, so none replaces another unread.
  if (announcer.queue.push(text) > 1) return;
  origin.ownerDocument.defaultView!.setTimeout(() => write(announcer.queue.splice(0).join(" ")), Math.max(0, wait));
};

export const registerDropTarget = (element: HTMLElement, initial: Omit<Target, "element">) => {
  const engine = engineFor(element.ownerDocument);
  const entry: Target = { element, ...initial };
  // The live region exists long before the first drag, so its first announcement is read.
  announcerFor(element);
  engine.targets.add(entry);
  engine.byElement.set(element, entry);
  mark(entry, engine.session?.payload);
  engine.session?.targetsChanged?.();
  return {
    update(next: Omit<Target, "element">) {
      Object.assign(entry, next);
      mark(entry, engine.session?.payload);
      engine.session?.targetsChanged?.();
    },
    dispose() {
      engine.targets.delete(entry);
      if (engine.byElement.get(element) === entry) engine.byElement.delete(element);
      delete element.dataset.drop;
      engine.session?.targetsChanged?.();
    },
  };
};

export const statusFor = (messages: DragAndDropMessages, payload: DragPayload, over?: Target): DragStatus => ({
  lead: messages.statusLead({ label: payload.label, count: payload.count ?? 1 }),
  detail: over && !over.cancels ? messages.statusOver({ target: over.label }) : messages.statusIdle,
});

/** Attributes that mark the dragged row itself; its copy in the preview shows the row as it was. */
const DRAG_MARKS = [
  "data-dragging",
  "data-held",
  "data-pressing",
  "data-sortable-dragging",
  "data-sortable-line",
  "data-sortable-handle",
  "data-sortable-path",
  "id",
  // A copied radio with the same name would uncheck the original; a copied field would join a form.
  "name",
  "form",
];
/**
 * A copy of `shown` for the preview, inside a shallow copy of its parent, so the parent's class and attribute
 * selectors still style it. Canvases keep their picture.
 */
const copyOf = (shown: HTMLElement): HTMLElement => {
  const copy = shown.cloneNode(true) as HTMLElement;
  const frame = shown.parentElement?.cloneNode(false) as HTMLElement | undefined;
  for (const element of [copy, ...copy.querySelectorAll("*")]) for (const name of DRAG_MARKS) element.removeAttribute(name);
  // Frames and media would load or play again; an empty box of the same size stands in.
  const MEDIA = "iframe, video, audio, object, embed";
  const originals = shown.querySelectorAll<HTMLElement>(MEDIA);
  copy.querySelectorAll(MEDIA).forEach((media, index) => {
    const box = media.ownerDocument.createElement("div");
    box.style.cssText = `width:${originals[index]?.offsetWidth ?? 0}px;height:${originals[index]?.offsetHeight ?? 0}px`;
    media.replaceWith(box);
  });
  const canvases = shown.querySelectorAll("canvas");
  copy.querySelectorAll("canvas").forEach((canvas, index) => {
    const original = canvases[index]!;
    if (original.width && original.height) canvas.getContext("2d")?.drawImage(original, 0, 0);
  });
  if (!frame) return copy;
  for (const name of [...DRAG_MARKS, "aria-label", "aria-labelledby", "aria-describedby", "role", "style"]) frame.removeAttribute(name);
  frame.style.display = "contents";
  frame.append(copy);
  return frame;
};

export const clearSession = (engine: Engine, session: Session, source?: HTMLElement) => {
  if (engine.session !== session) return;
  engine.session = undefined;
  if (source) delete source.dataset.dragging;
  for (const target of engine.targets) mark(target);
  setActiveDrag(undefined);
  writeDragStatus(undefined);
};

/**
 * Suppresses the click and touchend that follow the release of a drag or a hold. A drag cancelled while the button is
 * still down waits for that pointer's release; a new press or a cancelled pointer drops the wait.
 */
const swallowRelease = (doc: Document, pointerId?: number) => {
  const win = doc.defaultView!;
  if (pointerId !== undefined) {
    const stop = () => {
      win.removeEventListener("pointerup", released, true);
      win.removeEventListener("pointercancel", gone, true);
      win.removeEventListener("pointerdown", gone, true);
    };
    const released = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      stop();
      swallowRelease(doc);
    };
    const gone = (event: PointerEvent) => {
      if (event.type === "pointerdown" || event.pointerId === pointerId) stop();
    };
    win.addEventListener("pointerup", released, true);
    win.addEventListener("pointercancel", gone, true);
    win.addEventListener("pointerdown", gone, true);
    return;
  }
  const click = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    win.removeEventListener("click", click, true);
  };
  const touchEnd = (event: Event) => event.preventDefault();
  win.addEventListener("click", click, true);
  win.addEventListener("touchend", touchEnd, { capture: true, passive: false });
  win.setTimeout(() => {
    win.removeEventListener("click", click, true);
    win.removeEventListener("touchend", touchEnd, true);
  }, 0);
};

/** Walks ancestors only; neither hit testing nor scrolling scans the target registry. */
const SCROLLS = /^(auto|scroll|overlay)$/;
const LOCKED = /^(hidden|clip)$/;
/**
 * Scrolls the first container under the pointer that can still scroll toward the edge the pointer rests near. The
 * walk stops at a dialog, so the page behind a modal never scrolls, and the viewport scrolls only while the page is
 * not locked, as `dialogCore` locks it with `overflow: hidden`.
 */
const scrollAt = (doc: Document, hit: Element | null, x: number, y: number, cache: WeakMap<Element, { x: string; y: string }>) => {
  const win = doc.defaultView!;
  const root = doc.scrollingElement;
  const overflowOf = (element: Element) => {
    let overflow = cache.get(element);
    if (!overflow) {
      const style = win.getComputedStyle(element);
      overflow = { x: style.overflowX, y: style.overflowY };
      cache.set(element, overflow);
    }
    return overflow;
  };
  for (let element = hit; element; element = element.parentElement) {
    const viewport = element === root;
    let canX: boolean;
    let canY: boolean;
    if (viewport) {
      // The body's overflow applies to the viewport while the root's is visible.
      const own = overflowOf(element);
      const body = doc.body ? overflowOf(doc.body) : own;
      canX = !LOCKED.test(own.x) && !(own.x === "visible" && LOCKED.test(body.x));
      canY = !LOCKED.test(own.y) && !(own.y === "visible" && LOCKED.test(body.y));
    } else {
      const own = overflowOf(element);
      canX = SCROLLS.test(own.x);
      canY = SCROLLS.test(own.y);
    }
    const rect = viewport ? { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight } : element.getBoundingClientRect();
    const step = (point: number, start: number, end: number, position: number, max: number) => {
      if (point < start || point > end) return 0;
      const before = point - start;
      const after = end - point;
      if (before < AUTOSCROLL_EDGE && position > 0) return -Math.max(1, Math.ceil(12 * (1 - before / AUTOSCROLL_EDGE)));
      if (after < AUTOSCROLL_EDGE && position < max) return Math.max(1, Math.ceil(12 * (1 - after / AUTOSCROLL_EDGE)));
      return 0;
    };
    const dx = canX
      ? step(x, rect.left, rect.right, element.scrollLeft, element.scrollWidth - (viewport ? win.innerWidth : element.clientWidth))
      : 0;
    const dy = canY
      ? step(y, rect.top, rect.bottom, element.scrollTop, element.scrollHeight - (viewport ? win.innerHeight : element.clientHeight))
      : 0;
    if (dx || dy) {
      const beforeX = element.scrollLeft;
      const beforeY = element.scrollTop;
      element.scrollLeft += dx;
      element.scrollTop += dy;
      if (element.scrollLeft !== beforeX || element.scrollTop !== beforeY) return true;
    }
    if (element instanceof HTMLDialogElement) return false;
  }
  return false;
};

export const bindDragSource = (
  source: HTMLElement,
  read: () => {
    payload: DragPayload;
    disabled?: boolean;
    messages: DragAndDropMessages;
    /** Internal: the element the preview shows a copy of, such as a sortable row; else the preview is a label. */
    preview?: HTMLElement;
    /** Internal: how long a finger holds before it lifts, in ms; `HOLD_MS` by default. */
    hold?: number;
    /** How far the mouse or pen moves before the drag starts, in px; `SLOP` by default. */
    threshold?: number;
    /** "none": a finger never drags this source; its press stays with the host, such as a long-press menu. */
    touch?: "drag" | "none";
    /** With `touch: "none"`: a finger held 500 ms, moving at most 8 px, calls this instead of dragging (S7). */
    onLongPress?: (point: { x: number; y: number }) => void;
  },
): (() => void) => {
  const doc = source.ownerDocument;
  const win = doc.defaultView!;
  const engine = engineFor(doc);
  let abandon: (() => void) | undefined;
  /** Set while a held finger or a drag owns the touch, so the page must not scroll. */
  let blockTouch = false;
  /**
   * Bound for the source's whole life: WebKit decides at touchstart whether a touch can still be kept from scrolling,
   * and only a non-passive listener present by then lets the later hold do so.
   */
  const preventScroll = (event: TouchEvent) => {
    if (blockTouch && event.cancelable) event.preventDefault();
  };
  /**
   * Fields, editable text, and marked regions inside the source keep their own press and native drag, and so does a
   * whole source inside editable content, such as a paragraph in an editor.
   */
  const ignored = (target: EventTarget | null) => {
    // An SVG part has no editable state of its own; its nearest HTML ancestor tells.
    let html = target instanceof Element ? target : null;
    while (html && !(html instanceof HTMLElement)) html = html.parentElement;
    if (html instanceof HTMLElement && html.isContentEditable) return true;
    const found = target instanceof Element ? target.closest(IGNORE) : null;
    return found !== null && source.contains(found);
  };
  const nativeDrag = (event: Event) => {
    if (!ignored(event.target)) event.preventDefault();
  };
  /** A mouse that moved sideways before the threshold may have begun selecting the source's text; a drag ends that. */
  const clearStartedSelection = () => {
    const selection = doc.getSelection();
    if (selection && !selection.isCollapsed && selection.anchorNode && source.contains(selection.anchorNode)) selection.removeAllRanges();
  };
  const down = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || engine.session || read().disabled) return;
    if (!(event.target instanceof Element) || event.target.closest(".k2b-drag-source") !== source) return;
    if (ignored(event.target)) return;
    if (event.pointerType === "touch" && read().touch === "none") {
      const longPress = read().onLongPress;
      if (longPress) pressLong(event, longPress);
      return;
    }
    for (const listener of pressListeners) listener();
    const slop = read().threshold ?? SLOP;
    engine.abandonPress?.();
    // Ready before the drag starts, so its first announcement is read.
    announcerFor(source);
    const id = event.pointerId;
    const mouse = event.pointerType === "mouse";
    // A pen drags like the mouse where a finger does not drag at all (S7); elsewhere it holds first, like a finger.
    const fine = mouse || (event.pointerType === "pen" && read().touch === "none");
    const start = { x: event.clientX, y: event.clientY };
    let point = start;
    let held = false;
    let finished = false;
    /** The pointer went up or away, so no click of this press is still to come. */
    let released = false;
    let session: Session | undefined;
    let messages: DragAndDropMessages;
    let preview: HTMLElement | undefined;
    let releaseSelection: (() => void) | undefined;
    let frame = 0;
    let timer: number | undefined;
    let over: Target | undefined;
    let refused: Target | undefined;
    const overflowCache = new WeakMap<Element, { x: string; y: string }>();
    const hold = () => {
      if (held || finished) return;
      win.clearTimeout(timer);
      if (read().disabled) {
        cancel();
        return;
      }
      held = true;
      blockTouch = true;
      source.dataset.held = "";
      win.addEventListener("keydown", key, true);
    };
    // Android reports a long press as a context-menu event, which may come before the timer and opens a GestureMenu
    // around the source then. It counts as the hold, so the following move drags.
    const preventContext = (event: Event) => {
      event.preventDefault();
      if (!session) hold();
    };
    const clean = () => {
      if (finished) return;
      finished = true;
      win.clearTimeout(timer);
      win.cancelAnimationFrame(frame);
      win.removeEventListener("pointermove", move, true);
      win.removeEventListener("pointerup", up, true);
      win.removeEventListener("pointercancel", cancelPointer, true);
      win.removeEventListener("pointerdown", other, true);
      win.removeEventListener("blur", cancel);
      win.removeEventListener("keydown", key, true);
      win.removeEventListener("contextmenu", preventContext, true);
      blockTouch = false;
      source.removeEventListener("lostpointercapture", lostCapture);
      if (source.hasPointerCapture?.(id)) source.releasePointerCapture(id);
      delete source.dataset.held;
      delete source.dataset.pressing;
      preview?.remove();
      if (shownPreview === preview) shownPreview = undefined;
      releaseSelection?.();
      if (engine.abandonPress === cancel) engine.abandonPress = undefined;
      if (abandon === cancel) abandon = undefined;
      if (session) {
        // The browser may have extended that selection during the drag; nothing of it stays.
        clearStartedSelection();
        clearSession(engine, session, source);
        swallowRelease(doc, released ? undefined : id);
      } else if (held) swallowRelease(doc, released ? undefined : id);
    };
    const cancel = () => {
      if (finished) return;
      const payload = session?.payload;
      // The target forgets the place it showed, so nothing of a cancelled drag can land later.
      over?.hover?.(undefined);
      clean();
      if (payload) {
        announce(source, messages.cancelled(payload));
        notifyDragEnd(payload, false);
      }
    };
    const hitTest = () => {
      const payload = session!.payload;
      const hit = doc.elementFromPoint(point.x, point.y);
      let inner: Target | undefined;
      let next: Target | undefined;
      for (let element = hit; element; element = element.parentElement) {
        const target = engine.byElement.get(element);
        // A dialog is a boundary: a target around it lies behind it.
        if (!target && element instanceof HTMLDialogElement) break;
        if (!target) continue;
        inner ??= target;
        if (accepts(target, payload)) {
          next = target;
          break;
        }
      }
      // A target that takes nothing inside an area where letting go changes nothing, such as a disabled tile on a
      // drop overlay, refuses: it says why, instead of the area around it.
      if (next?.cancels && inner && inner !== next) next = undefined;
      const rejected = next ? undefined : inner;
      if (next !== over || rejected !== refused) {
        if (next !== over) over?.hover?.(undefined);
        if (over) mark(over, engine.targets.has(over) ? payload : undefined);
        if (refused) mark(refused, engine.targets.has(refused) ? payload : undefined);
        over = next;
        refused = rejected;
        if (over) {
          over.element.dataset.drop = "over";
          if (!over.hover) announce(source, over.messages.over({ target: over.label }));
        } else if (refused) {
          refused.element.dataset.drop = "refused";
          announce(source, refused.messages.refused({ target: refused.label, label: payload.label }));
        }
        if (!over?.hover) writeDragStatus(statusFor(messages, payload, over));
      }
      lineY = over?.hover?.(point);
      if (over) over.element.dataset.drop = "over";
      if (refused) refused.element.dataset.drop = "refused";
      return hit;
    };
    let previewWidth = 0;
    let previewHeight = 0;
    /** The line the target shows, such as a sorted list's place far below the pointer. */
    let lineY: number | undefined;
    /**
     * Follows the pointer. Its CSS `translate` hangs it 16 px left of and below this point, so it starts below the
     * pointer and below the target's line, which it never covers. Near the viewport's right edge a wide preview
     * shifts left so it stays whole.
     */
    const place = () => {
      const x = previewWidth ? Math.max(24, Math.min(point.x, win.innerWidth - previewWidth + 8)) : point.x;
      let y = lineY === undefined ? point.y : Math.max(point.y, lineY - 8);
      // Near the viewport's lower edge the preview would leave the window: it flips above the pointer and above the
      // line, so it stays in view and still never covers the line. The CSS translate adds 16 px.
      if (previewHeight && y + 16 + previewHeight > win.innerHeight - 8) {
        const above = lineY === undefined ? point.y : Math.min(point.y, lineY - 4);
        y = Math.max(-8, above - 8 - previewHeight - 16);
      }
      preview!.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    };
    const renderFrame = () => {
      frame = 0;
      if (finished || !session) return;
      const hit = hitTest();
      place();
      if (scrollAt(doc, hit, point.x, point.y, overflowCache)) frame = win.requestAnimationFrame(renderFrame);
    };
    const begin = () => {
      const current = read();
      if (current.disabled || engine.session) {
        cancel();
        return;
      }
      const payload = { ...current.payload };
      messages = current.messages;
      session = {
        payload,
        origin: source,
        cancel,
        targetsChanged: () => {
          if (!frame) frame = win.requestAnimationFrame(renderFrame);
        },
      };
      engine.session = session;
      for (const listener of dragStartListeners) listener(id);
      if (finished) return;
      delete source.dataset.held;
      source.dataset.dragging = "";
      win.addEventListener("contextmenu", preventContext, true);
      releaseSelection = suppressTextSelection(id);
      clearStartedSelection();
      // Captured, the mouse's moves and release reach this drag also over an iframe, such as a PDF preview. A finger
      // or pen is captured by the browser already.
      if (mouse)
        try {
          source.setPointerCapture(id);
          source.addEventListener("lostpointercapture", lostCapture);
        } catch {
          // The pointer is already gone; its pointerup or pointercancel ends the drag.
        }
      preview = doc.createElement("div");
      shownPreview = preview;
      // Inside the source's own .k2b-ui scope the preview inherits its theme, also a scoped dark one; a second
      // .k2b-ui would reset the tokens to light.
      const scope = source.parentElement?.closest<HTMLElement>(".k2b-ui");
      preview.className = scope ? "k2b-drag-preview" : "k2b-ui k2b-drag-preview";
      preview.setAttribute("aria-hidden", "true");
      const shown = current.preview;
      if (shown?.isConnected) {
        // The row itself floats, at its own width, so its text wraps as it did in place.
        preview.dataset.preview = "row";
        preview.style.width = `${Math.round(shown.getBoundingClientRect().width)}px`;
        preview.setAttribute("inert", "");
        preview.append(copyOf(shown));
      } else {
        const icon = doc.createElement("i");
        icon.className = payload.icon ?? "ti ti-file";
        const label = doc.createElement("span");
        label.className = "k2b-drag-preview__label";
        label.textContent = payload.label;
        preview.append(icon, label);
      }
      if (payload.count && payload.count > 1) {
        const count = doc.createElement("span");
        count.className = "k2b-drag-preview__count";
        count.textContent = String(payload.count);
        preview.append(count);
      }
      // In the top layer the preview is placed against the viewport, also inside a transformed dialog, and stays above it.
      preview.setAttribute("popover", "manual");
      getK2bPortalRoot(scope ?? doc.body, source, doc).append(preview);
      preview.showPopover?.();
      previewWidth = preview.offsetWidth;
      previewHeight = preview.offsetHeight;
      place();
      for (const target of engine.targets) mark(target, payload);
      writeDragStatus(statusFor(messages, payload));
      setActiveDrag(payload);
      if (finished) return;
      announce(source, messages.pickedUp(payload));
      win.addEventListener("keydown", key, true);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== id || finished) return;
      point = { x: event.clientX, y: event.clientY };
      if (!session && Math.hypot(point.x - start.x, point.y - start.y) >= slop) {
        if (!fine && !held) {
          cancel();
          return;
        }
        begin();
      }
      if (session && !finished && !frame) frame = win.requestAnimationFrame(renderFrame);
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== id || finished) return;
      released = true;
      if (!session) {
        clean();
        return;
      }
      point = { x: event.clientX, y: event.clientY };
      hitTest();
      // A target that means "nothing happens" ends the drag like letting go outside.
      const target = over?.cancels ? undefined : over;
      const payload = session.payload;
      const result = target ? target.messages.dropped({ label: payload.label, target: target.label }) : messages.cancelled(payload);
      const drop = target?.drop;
      clean();
      announce(source, result);
      drop?.(payload);
      notifyDragEnd(payload, target !== undefined);
    };
    // Capture ends without a release only when the browser takes the pointer away.
    const lostCapture = (event: PointerEvent) => {
      if (event.pointerId === id) cancel();
    };
    const cancelPointer = (event: PointerEvent) => {
      if (event.pointerId !== id) return;
      released = true;
      cancel();
    };
    const other = (event: PointerEvent) => {
      if (event.pointerId !== id) cancel();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A hold is not a drag yet: Escape ends it and still reaches the menu the hold opened.
      if (!session) {
        cancel();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    abandon = cancel;
    engine.abandonPress = cancel;
    win.addEventListener("pointermove", move, true);
    win.addEventListener("pointerup", up, true);
    win.addEventListener("pointercancel", cancelPointer, true);
    win.addEventListener("pointerdown", other, true);
    win.addEventListener("blur", cancel);
    if (!fine) {
      // A held finger drags: it selects no text, and Android's long-press menu does not open, also before the hold fires.
      source.dataset.pressing = "";
      win.addEventListener("contextmenu", preventContext, true);
      timer = win.setTimeout(hold, read().hold ?? HOLD_MS);
    }
  };
  /**
   * A finger on a source that does not drag by touch: held still, it calls `open` at the point; moving, lifting,
   * or another pointer ends the wait. The release after it never clicks the row.
   */
  const pressLong = (event: PointerEvent, open: (point: { x: number; y: number }) => void) => {
    const id = event.pointerId;
    const start = { x: event.clientX, y: event.clientY };
    const stop = () => {
      win.clearTimeout(timer);
      win.removeEventListener("pointermove", move, true);
      win.removeEventListener("pointerup", end, true);
      win.removeEventListener("pointercancel", end, true);
      win.removeEventListener("contextmenu", menu, true);
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId === id && Math.hypot(next.clientX - start.x, next.clientY - start.y) > LONG_PRESS_SLOP) stop();
    };
    const end = (next: PointerEvent) => {
      if (next.pointerId === id) stop();
    };
    // The platform's own long-press menu would cover the host's.
    const menu = (next: Event) => next.preventDefault();
    const timer = win.setTimeout(() => {
      stop();
      swallowRelease(doc, id);
      open(start);
    }, LONG_PRESS_MS);
    win.addEventListener("pointermove", move, true);
    win.addEventListener("pointerup", end, true);
    win.addEventListener("pointercancel", end, true);
    win.addEventListener("contextmenu", menu, true);
  };
  announcerFor(source);
  source.addEventListener("pointerdown", down);
  source.addEventListener("dragstart", nativeDrag);
  source.addEventListener("touchmove", preventScroll, { passive: false });
  return () => {
    abandon?.();
    if (engine.session && source.contains(engine.session.origin)) engine.session.cancel();
    source.removeEventListener("pointerdown", down);
    source.removeEventListener("dragstart", nativeDrag);
    source.removeEventListener("touchmove", preventScroll);
  };
};
