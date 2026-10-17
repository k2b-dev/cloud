import { createSignal } from "solid-js";
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
const HOLD_MS = 500;
const AUTOSCROLL_EDGE = 32;
const [readActiveDrag, setActiveDrag] = createSignal<DragPayload>();
/** Reactive payload of the drag in progress, or undefined. */
export const activeDrag = (): DragPayload | undefined => readActiveDrag();
const dragStartListeners = new Set<(pointerId: number) => void>();
/** Internal hand-over to the gesture menu that owns this press. */
export const onPointerDragStart = (listener: (pointerId: number) => void): (() => void) => {
  dragStartListeners.add(listener);
  return () => dragStartListeners.delete(listener);
};

type Target = {
  element: HTMLElement;
  accept: readonly string[];
  label: string;
  messages: DragAndDropMessages;
  disabled?: boolean;
  drop: (payload: DragPayload) => void;
};
type Session = {
  payload: DragPayload;
  origin: HTMLElement;
  cancel: () => void;
  targetsChanged?: () => void;
};
type Engine = {
  targets: Set<Target>;
  byElement: WeakMap<Element, Target>;
  session?: Session;
  abandonPress?: () => void;
};
const engines = new WeakMap<Document, Engine>();
const engineFor = (doc: Document): Engine => {
  let engine = engines.get(doc);
  if (!engine) {
    engine = { targets: new Set(), byElement: new WeakMap() };
    engines.set(doc, engine);
  }
  return engine;
};
const accepts = (target: Target, payload: DragPayload) =>
  target.element.isConnected && !target.disabled && target.accept.includes(payload.type);
const isModal = (dialog: Element) => {
  try {
    return dialog.matches(":modal");
  } catch {
    return dialog.matches("dialog[open]");
  }
};
/** The modal dialog around an element; while one is open, everything outside of it is inert. */
const modalOf = (element: Element): Element | undefined => {
  for (let dialog = element.closest("dialog"); dialog; dialog = dialog.parentElement?.closest("dialog") ?? null)
    if (isModal(dialog)) return dialog;
  return undefined;
};
/**
 * A keyboard destination must be one a pointer could reach from where the pickup started: shown and visible, not
 * inert, and in the same modal dialog as the origin.
 */
const reachable = (target: Target, origin: HTMLElement) => {
  const element = target.element;
  if (element.closest("[inert]") || modalOf(element) !== modalOf(origin)) return false;
  if (typeof element.checkVisibility === "function") return element.checkVisibility({ checkVisibilityCSS: true });
  return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
};
const mark = (target: Target, payload?: DragPayload) => {
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
    parent.append(region);
    announcer = { region, ready: performance.now() + ANNOUNCE_DELAY_MS, queue: [] };
    announcers.set(parent, announcer);
  }
  return announcer;
};
const announce = (origin: HTMLElement, text: string) => {
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
      engine.byElement.delete(element);
      delete element.dataset.drop;
      engine.session?.targetsChanged?.();
    },
  };
};

const clearSession = (engine: Engine, session: Session, source?: HTMLElement) => {
  if (engine.session !== session) return;
  engine.session = undefined;
  if (source) delete source.dataset.dragging;
  for (const target of engine.targets) mark(target);
  setActiveDrag(undefined);
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
  read: () => { payload: DragPayload; disabled?: boolean; messages: DragAndDropMessages },
): (() => void) => {
  const doc = source.ownerDocument;
  const win = doc.defaultView!;
  const engine = engineFor(doc);
  let abandon: (() => void) | undefined;
  const nativeDrag = (event: Event) => event.preventDefault();
  const down = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || engine.session || read().disabled) return;
    if (!(event.target instanceof Element) || event.target.closest(".k2b-drag-source") !== source) return;
    const ignored = event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [data-drag-ignore]");
    if (ignored && source.contains(ignored)) return;
    engine.abandonPress?.();
    // Ready before the drag starts, so its first announcement is read.
    announcerFor(source);
    const id = event.pointerId;
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
    const preventScroll = (event: TouchEvent) => {
      if (event.cancelable) event.preventDefault();
    };
    const preventContext = (event: Event) => event.preventDefault();
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
      doc.removeEventListener("touchmove", preventScroll);
      delete source.dataset.held;
      delete source.dataset.pressing;
      preview?.remove();
      releaseSelection?.();
      if (engine.abandonPress === cancel) engine.abandonPress = undefined;
      if (abandon === cancel) abandon = undefined;
      if (session) {
        clearSession(engine, session, source);
        swallowRelease(doc, released ? undefined : id);
      } else if (held) swallowRelease(doc, released ? undefined : id);
    };
    const cancel = () => {
      if (finished) return;
      const payload = session?.payload;
      clean();
      if (payload) announce(source, messages.cancelled(payload));
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
      const rejected = next ? undefined : inner;
      if (next !== over || rejected !== refused) {
        if (over) mark(over, engine.targets.has(over) ? payload : undefined);
        if (refused) mark(refused, engine.targets.has(refused) ? payload : undefined);
        over = next;
        refused = rejected;
        if (over) {
          over.element.dataset.drop = "over";
          announce(source, over.messages.over({ target: over.label }));
        } else if (refused) {
          refused.element.dataset.drop = "refused";
          announce(source, refused.messages.refused({ target: refused.label, label: payload.label }));
        }
      }
      if (over) over.element.dataset.drop = "over";
      if (refused) refused.element.dataset.drop = "refused";
      return hit;
    };
    const renderFrame = () => {
      frame = 0;
      if (finished || !session) return;
      preview!.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
      const hit = hitTest();
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
      preview = doc.createElement("div");
      preview.className = "k2b-ui k2b-drag-preview";
      preview.setAttribute("aria-hidden", "true");
      const icon = doc.createElement("i");
      icon.className = payload.icon ?? "ti ti-file";
      const label = doc.createElement("span");
      label.className = "k2b-drag-preview__label";
      label.textContent = payload.label;
      preview.append(icon, label);
      if (payload.count && payload.count > 1) {
        const count = doc.createElement("span");
        count.className = "k2b-drag-preview__count";
        count.textContent = String(payload.count);
        preview.append(count);
      }
      // In the top layer the preview is placed against the viewport, also inside a transformed dialog, and stays above it.
      preview.setAttribute("popover", "manual");
      containerFor(source).append(preview);
      preview.showPopover?.();
      preview.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
      for (const target of engine.targets) mark(target, payload);
      setActiveDrag(payload);
      if (finished) return;
      announce(source, messages.pickedUp(payload));
      win.addEventListener("keydown", key, true);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== id || finished) return;
      point = { x: event.clientX, y: event.clientY };
      if (!session && Math.hypot(point.x - start.x, point.y - start.y) >= SLOP) {
        if (event.pointerType !== "mouse" && !held) {
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
      const target = over;
      const payload = session.payload;
      const result = target ? target.messages.dropped({ label: payload.label, target: target.label }) : messages.cancelled(payload);
      const drop = target?.drop;
      clean();
      announce(source, result);
      drop?.(payload);
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
    if (event.pointerType !== "mouse") {
      // A held finger drags: it selects no text, and Android's long-press menu does not open, also before the hold fires.
      source.dataset.pressing = "";
      win.addEventListener("contextmenu", preventContext, true);
      timer = win.setTimeout(() => {
        if (read().disabled) {
          cancel();
          return;
        }
        held = true;
        source.dataset.held = "";
        doc.addEventListener("touchmove", preventScroll, { passive: false });
      }, HOLD_MS);
    }
  };
  announcerFor(source);
  source.addEventListener("pointerdown", down);
  source.addEventListener("dragstart", nativeDrag);
  return () => {
    abandon?.();
    if (engine.session && source.contains(engine.session.origin)) engine.session.cancel();
    source.removeEventListener("pointerdown", down);
    source.removeEventListener("dragstart", nativeDrag);
  };
};

const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";
/** The origin itself when it takes focus, else the nearest ancestor that does, such as a menu's group. */
const focusTarget = (origin: HTMLElement): HTMLElement =>
  (origin.matches(FOCUSABLE) ? origin : origin.closest<HTMLElement>(FOCUSABLE)) ?? origin;

export const startKeyboardDrag = (input: DragPayload, origin: HTMLElement, messages: DragAndDropMessages): (() => void) => {
  const doc = origin.ownerDocument;
  const win = doc.defaultView!;
  const engine = engineFor(doc);
  engine.session?.cancel();
  engine.abandonPress?.();
  const payload = { ...input };
  const choices = () =>
    [...engine.targets]
      .filter((target) => accepts(target, payload) && reachable(target, origin))
      .sort((a, b) => (a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  let targets: Target[] = [];
  let current: Target | undefined;
  /** Listening for keys: the first destination is chosen. */
  let ready = false;
  let finished = false;
  let frame = 0;
  const source = origin.closest<HTMLElement>(".k2b-drag-source") ?? undefined;
  const end = (target?: Target, text?: string) => {
    if (finished) return;
    finished = true;
    win.cancelAnimationFrame(frame);
    doc.removeEventListener("keydown", key, true);
    doc.removeEventListener("pointerdown", cancel, true);
    win.removeEventListener("blur", cancel);
    const result = text ?? (target ? target.messages.dropped({ label: payload.label, target: target.label }) : messages.cancelled(payload));
    const drop = target?.drop;
    clearSession(engine, session, source);
    announce(origin, result);
    if (origin.isConnected) focusTarget(origin).focus({ preventScroll: true });
    drop?.(payload);
  };
  const cancel = () => end();
  const describe = (target: Target) =>
    target.messages.choice({ target: target.label, index: targets.indexOf(target) + 1, count: targets.length });
  const choose = (target: Target, text = describe(target)) => {
    if (current) mark(current, engine.targets.has(current) ? payload : undefined);
    current = target;
    current.element.dataset.drop = "over";
    current.element.scrollIntoView({ block: "nearest", inline: "nearest" });
    announce(origin, text);
  };
  const key = (event: KeyboardEvent) => {
    const index = current ? targets.indexOf(current) : -1;
    let next: number | undefined;
    if (["ArrowDown", "ArrowRight", "Tab"].includes(event.key)) next = index + (event.key === "Tab" && event.shiftKey ? -1 : 1);
    else if (["ArrowUp", "ArrowLeft"].includes(event.key)) next = index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = targets.length - 1;
    else if (!["Enter", " ", "Escape"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (next !== undefined) choose(targets[(next + targets.length) % targets.length]!);
    else if (event.key === "Escape") cancel();
    else end(current && accepts(current, payload) && reachable(current, origin) ? current : undefined);
  };
  /** Chooses the first destination and starts listening; without one, the sequence ends at once. */
  const settle = () => {
    targets = choices();
    if (!targets.length) {
      end(undefined, messages.noTarget(payload));
      return;
    }
    ready = true;
    // One announcement, so a screen reader does not drop the instructions for the first choice.
    choose(targets[0]!, `${messages.pickedUpKeyboard({ label: payload.label, count: targets.length })} ${describe(targets[0]!)}`);
    // A menu's activating key has already traversed capture. Defer the listener until that dispatch has ended.
    queueMicrotask(() => {
      if (finished) return;
      doc.addEventListener("keydown", key, true);
      doc.addEventListener("pointerdown", cancel, true);
      win.addEventListener("blur", cancel);
    });
  };
  const session: Session = {
    payload,
    origin,
    cancel,
    targetsChanged() {
      if (!ready || finished) return;
      targets = choices();
      if (!targets.length) cancel();
      else choose(current && targets.includes(current) ? current : targets[0]!);
    },
  };
  // The drag is active before destinations are counted, so a host can mount the ones it shows only while dragging.
  engine.session = session;
  for (const target of engine.targets) mark(target, payload);
  if (source) source.dataset.dragging = "";
  setActiveDrag(payload);
  if (finished) return cancel;
  if (choices().length) settle();
  else
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      if (!finished) settle();
    });
  return cancel;
};
