import { i18n } from "@k2b/stdlib";
import { announce, setDragStatus } from "./drag-and-drop";
import type { DragAndDropMessages } from "./drag-and-drop-messages";
import {
  commit,
  type Entry,
  find,
  keyboardLift,
  type Lift,
  landing,
  lift,
  listsOf,
  place,
  placesIn,
  refocus,
  setLift,
  staying,
} from "./sortable-board";
import { clampIndex } from "./sortable-place";

/*
 * Lifting a row with Space and choosing its place with the arrow keys. It runs only after a person presses Space on a
 * grip, so SortableList loads this module on demand and pages that never lift a row by keyboard do not ship it.
 */

type Place = { position: number; count: number; list: string };
const sortableKeyboardMessages = /* @__PURE__ */ i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      lifted: ({ label, position, count, list }: Place & { label: string }) =>
        `${label} lifted. Position ${position} of ${count} in “${list}”. The arrow keys choose a place, Enter drops, Escape cancels.`,
      dropped: ({ label, position, count, list }: Place & { label: string }) =>
        `${label} dropped, position ${position} of ${count} in “${list}”.`,
      cancelled: ({ label }: { label: string }) => `Cancelled. ${label} stays where it was.`,
      status: ({ position, list }: { position: number; list: string }) => `to “${list}”, place ${position} · Enter drops, Esc cancels`,
      stay: "stays put · arrows choose, Esc cancels",
    },
    de: {
      lifted: ({ label, position, count, list }: Place & { label: string }) =>
        `${label} angehoben. Position ${position} von ${count} in „${list}“. Pfeiltasten wählen den Platz, Enter legt ab, Escape bricht ab.`,
      dropped: ({ label, position, count, list }: Place & { label: string }) =>
        `${label} abgelegt, Position ${position} von ${count} in „${list}“.`,
      cancelled: ({ label }: { label: string }) => `Abgebrochen. ${label} bleibt an seinem Platz.`,
      status: ({ position, list }: { position: number; list: string }) =>
        `nach „${list}“, Platz ${position} · Enter legt ab, Esc bricht ab`,
      stay: "bleibt am Platz · Pfeile wählen, Esc bricht ab",
    },
  },
});
export const checkSortableKeyboardMessages = () => sortableKeyboardMessages.check();
type Messages = ReturnType<(typeof sortableKeyboardMessages)["resolve"]>["t"];

/** The texts of the lift in progress, in the locale of the list it started in. */
let texts: Messages | undefined;

const showStatus = (state: Lift, to: Entry) => {
  if (state.index === undefined) return;
  setDragStatus({
    lead: state.messages.statusLead({ label: state.label, count: 1 }),
    detail: staying(state) ? texts!.stay : texts!.status({ position: state.index + 1, list: to.label() }),
  });
};

/** Lifts `key` of `entry`: nothing moves yet; the line and the status show the place. */
export const startLift = (entry: Entry, key: string, label: string, locale: string, messages: DragAndDropMessages) => {
  keyboardLift.end?.();
  texts = sortableKeyboardMessages.resolve([locale]).t;
  const fromIndex = entry.keys().indexOf(key);
  if (fromIndex < 0) return;
  const list = entry.list;
  const state: Lift = {
    group: entry.group,
    key,
    label,
    from: entry.key,
    fromIndex,
    to: entry.key,
    index: fromIndex,
    keyboard: true,
    messages,
  };
  setLift(state);
  showStatus(state, entry);
  announce(list, texts.lifted({ label, ...place(entry, state, fromIndex) }));
  const doc = list.ownerDocument;
  const win = doc.defaultView!;
  const end = () => {
    if (keyboardLift.end !== end) return;
    keyboardLift.end = undefined;
    keyboardLift.cancel = undefined;
    doc.removeEventListener("pointerdown", cancel, true);
    win.removeEventListener("blur", cancel);
    if (lift()?.keyboard) setLift(undefined);
    setDragStatus(undefined);
  };
  const cancel = () => {
    const current = lift();
    end();
    if (current) announce(list, texts!.cancelled({ label: current.label }));
  };
  keyboardLift.end = end;
  keyboardLift.cancel = cancel;
  doc.addEventListener("pointerdown", cancel, true);
  win.addEventListener("blur", cancel);
};

/** Keys while a row is lifted: choose a place, drop, or cancel. Nothing moves until the drop. */
export const liftedKey = (event: KeyboardEvent, state: Lift, entry: Entry) => {
  const group = state.group;
  const target = find(group, state.to) ?? entry;
  const count = placesIn(target, state.key);
  const choose = (to: Entry, index: number) => {
    const next = { ...state, to: to.key, index };
    setLift(next);
    showStatus(next, to);
    announce(entry.list, to.messages().position(place(to, next, index)));
    requestAnimationFrame(() => {
      const line = to.list.querySelector("[data-sortable-line]") ?? to.list;
      line.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  };
  const at = state.index ?? 0;
  const cancel = () => {
    keyboardLift.end?.();
    announce(entry.list, texts!.cancelled({ label: state.label }));
  };
  switch (event.key) {
    case "ArrowUp":
    case "ArrowDown":
    case "Home":
    case "End": {
      const wanted = { ArrowUp: at - 1, ArrowDown: at + 1, Home: 0, End: count - 1 }[event.key];
      choose(target, target.placement() ? landing(target, state, 0) : clampIndex(wanted, count));
      break;
    }
    case "ArrowLeft":
    case "ArrowRight": {
      const lists = listsOf(group).filter((other) => other === target || !other.disabled());
      const next = lists[lists.indexOf(target) + (event.key === "ArrowLeft" ? -1 : 1)] ?? target;
      choose(next, next.placement() ? landing(next, state, 0) : clampIndex(at, placesIn(next, state.key)));
      break;
    }
    case "Enter":
    case " ": {
      keyboardLift.end?.();
      const moved = commit(state);
      const to = find(group, state.to);
      if (to && state.index !== undefined) announce(entry.list, texts!.dropped({ label: state.label, ...place(to, state, state.index) }));
      if (moved) queueMicrotask(() => refocus(group, state.key));
      break;
    }
    case "Escape":
      cancel();
      break;
    case "Tab":
      cancel();
      return;
    default:
      return;
  }
  event.preventDefault();
  event.stopPropagation();
};
