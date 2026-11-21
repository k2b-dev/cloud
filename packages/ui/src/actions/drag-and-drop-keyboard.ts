import { i18n } from "@k2b/stdlib";
import {
  accepts,
  announce,
  clearSession,
  type DragPayload,
  engineFor,
  mark,
  type Session,
  setActiveDrag,
  statusFor,
  type Target,
  writeDragStatus,
} from "./drag-and-drop";
import type { DragAndDropMessages } from "./drag-and-drop-messages";

/*
 * The keyboard pickup that a menu entry starts. It runs only after a person asks for it, so `useKeyboardDrag` loads
 * this module on demand and pages that never pick up by keyboard do not ship it.
 */

const dragKeyboardMessages = /* @__PURE__ */ i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      pickedUp: ({ label, count }: { label: string; count: number }) =>
        `${label} picked up. ${count === 1 ? "1 place takes it" : `${count} places take it`}. Arrow keys choose a place, Enter drops, Escape cancels.`,
      choice: ({ target, index, count }: { target: string; index: number; count: number }) => `${target}, ${index} of ${count}.`,
      noTarget: ({ label }: { label: string }) => `No place here takes ${label}.`,
    },
    de: {
      pickedUp: ({ label, count }: { label: string; count: number }) =>
        `${label} angehoben. ${count === 1 ? "1 Ort nimmt es an" : `${count} Orte nehmen es an`}. Pfeiltasten wählen einen Ort, Eingabe legt ab, Escape bricht ab.`,
      choice: ({ target, index, count }: { target: string; index: number; count: number }) => `${target}, ${index} von ${count}.`,
      noTarget: ({ label }: { label: string }) => `Hier nimmt kein Ort ${label} an.`,
    },
  },
});
export const checkDragKeyboardMessages = () => dragKeyboardMessages.check();

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
const visible = (element: Element) =>
  typeof element.checkVisibility === "function"
    ? element.checkVisibility({ checkVisibilityCSS: true })
    : element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
/**
 * A keyboard destination must be one a pointer could reach from where the pickup started: shown and visible, not
 * inert, and in the same modal dialog as the origin.
 */
const reachable = (target: Target, origin: HTMLElement) => {
  const element = target.element;
  if (element.closest("[inert]") || modalOf(element) !== modalOf(origin)) return false;
  return visible(element);
};
const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";
/** The origin itself when it takes focus, else the nearest ancestor that does, such as a menu's group. */
const focusTarget = (origin: HTMLElement): HTMLElement =>
  (origin.matches(FOCUSABLE) ? origin : origin.closest<HTMLElement>(FOCUSABLE)) ?? origin;

export const startKeyboardDrag = (input: DragPayload, origin: HTMLElement, messages: DragAndDropMessages, locale: string): (() => void) => {
  const texts = dragKeyboardMessages.resolve([locale]).t;
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
    // Focus scrolls the origin back into view when choosing a destination scrolled it away.
    if (origin.isConnected) focusTarget(origin).focus();
    drop?.(payload);
  };
  const cancel = () => end();
  const pickupModal = modalOf(origin);
  /**
   * Whether a modal dialog opened over the pickup, leaving the origin inert: the key comes from inside another modal,
   * or a modal opened over a pickup that started outside of every modal.
   */
  const behindModal = (event: KeyboardEvent) => {
    const keyModal = event.target instanceof Element ? modalOf(event.target) : undefined;
    if (keyModal && keyModal !== pickupModal && !keyModal.contains(origin)) return true;
    // A dialog stack that shares one native dialog hides the level below, the origin's, when the next one opens.
    if (pickupModal && (!origin.isConnected || !visible(origin))) return true;
    return !pickupModal && Array.from(doc.querySelectorAll("dialog[open]")).some(isModal);
  };
  const describe = (target: Target) => texts.choice({ target: target.label, index: targets.indexOf(target) + 1, count: targets.length });
  const choose = (target: Target, text = describe(target)) => {
    if (current) mark(current, engine.targets.has(current) ? payload : undefined);
    current = target;
    current.element.dataset.drop = "over";
    current.element.scrollIntoView({ block: "nearest", inline: "nearest" });
    writeDragStatus(statusFor(messages, payload, target));
    announce(origin, text);
  };
  const key = (event: KeyboardEvent) => {
    const backward = event.key === "ArrowUp" || event.key === "ArrowLeft" || (event.key === "Tab" && event.shiftKey);
    const forward = !backward && (event.key === "ArrowDown" || event.key === "ArrowRight" || event.key === "Tab");
    if (!backward && !forward && !["Home", "End", "Enter", " ", "Escape"].includes(event.key)) return;
    // A modal dialog opened since the pickup: its keys are its own, and the pickup behind it ends.
    if (behindModal(event)) {
      cancel();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      cancel();
      return;
    }
    // Destinations may have been hidden or shown since the last key, for example by a layout change.
    targets = choices();
    if (!targets.length) {
      end(undefined, texts.noTarget(payload));
      return;
    }
    const index = current ? targets.indexOf(current) : -1;
    const count = targets.length;
    if (forward) choose(targets[index < 0 ? 0 : (index + 1) % count]!);
    else if (backward) choose(targets[index < 0 ? count - 1 : (index - 1 + count) % count]!);
    else if (event.key === "Home") choose(targets[0]!);
    else if (event.key === "End") choose(targets[count - 1]!);
    else end(index >= 0 ? current : undefined);
  };
  /** Chooses the first destination and starts listening; without one, the sequence ends at once. */
  const settle = () => {
    targets = choices();
    if (!targets.length) {
      end(undefined, texts.noTarget(payload));
      return;
    }
    ready = true;
    // One announcement, so a screen reader does not drop the instructions for the first choice.
    choose(targets[0]!, `${texts.pickedUp({ label: payload.label, count: targets.length })} ${describe(targets[0]!)}`);
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
    // Settled a frame later, so a target that a re-render replaces has registered again before none counts as left.
    targetsChanged() {
      if (!ready || finished || frame) return;
      frame = win.requestAnimationFrame(() => {
        frame = 0;
        if (finished) return;
        targets = choices();
        if (!targets.length) cancel();
        else choose(current && targets.includes(current) ? current : targets[0]!);
      });
    },
  };
  // The drag is active before destinations are counted, so a host can mount the ones it shows only while dragging.
  engine.session = session;
  for (const target of engine.targets) mark(target, payload);
  if (source) source.dataset.dragging = "";
  writeDragStatus(statusFor(messages, payload));
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
