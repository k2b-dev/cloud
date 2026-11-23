import { i18n } from "@k2b/stdlib";
import { useLocale } from "../../intl/locale";

type Move = { label: string; position: number; total: number };
type ListMove = Move & { list: string };

/**
 * Screen reader announcements of the v2 behaviours. ui-sdk's defaults are English only, so every behaviour passes these
 * message functions, resolved from the inherited render locale.
 */
const behaviorMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      sortGrab: ({ label, position, total }: Move) =>
        `${label} grabbed, position ${position} of ${total}. Arrow keys move it, Space drops it, Escape cancels.`,
      sortMove: ({ label, position, total }: Move) => `${label}, position ${position} of ${total}.`,
      sortDrop: ({ label, position, total }: Move) => `${label} dropped, position ${position} of ${total}.`,
      sortCancel: ({ label, position, total }: Move) => `Canceled. ${label} stays at position ${position} of ${total}.`,
      transferGrab: ({ label, list, position, total }: ListMove) =>
        `${label} grabbed, ${list}, position ${position} of ${total}. Left and Right change the list, Up and Down the place, Space drops it, Escape cancels.`,
      transferMove: ({ label, list, position, total }: ListMove) => `${label}, ${list}, position ${position} of ${total}.`,
      transferDrop: ({ label, list, position, total }: ListMove) => `${label} dropped in ${list}, position ${position} of ${total}.`,
      transferCancel: ({ label, list, position, total }: ListMove) =>
        `Canceled. ${label} stays in ${list}, position ${position} of ${total}.`,
      sortable: "sortable list",
      movable: "movable",
      ontoGrab: ({ label, target, index, total }: { label: string; target: string; index: number; total: number }) =>
        `${label} grabbed. Target: ${target}, ${index} of ${total}. Arrow keys choose the target, Enter drops, Escape cancels.`,
      ontoGrabPointer: ({ label }: { label: string }) => `${label} grabbed. Release over a target.`,
      ontoTarget: ({ target, index, total }: { target: string; index: number; total: number }) => `${target}, ${index} of ${total}.`,
      ontoDrop: ({ label, target }: { label: string; target: string }) => `${label} moved to ${target}.`,
      ontoCancel: "Canceled, nothing changed.",
      listResults: ({ count }: { count: number }) => (count === 1 ? "1 result" : `${count} results`),
      listEmpty: "No results",
      listRemoved: ({ label }: { label: string }) => `${label} removed`,
      loading: "Loading",
      width: ({ px }: { px: number }) => `${px} px`,
    },
    de: {
      sortGrab: ({ label, position, total }: Move) =>
        `${label} aufgenommen, Position ${position} von ${total}. Pfeiltasten verschieben, Leertaste legt ab, Escape bricht ab.`,
      sortMove: ({ label, position, total }: Move) => `${label}, Position ${position} von ${total}.`,
      sortDrop: ({ label, position, total }: Move) => `${label} abgelegt, Position ${position} von ${total}.`,
      sortCancel: ({ label, position, total }: Move) => `Abgebrochen. ${label} bleibt auf Position ${position} von ${total}.`,
      transferGrab: ({ label, list, position, total }: ListMove) =>
        `${label} aufgenommen, ${list}, Position ${position} von ${total}. Pfeile links und rechts wechseln die Liste, hoch und runter die Stelle, Leertaste legt ab, Escape bricht ab.`,
      transferMove: ({ label, list, position, total }: ListMove) => `${label}, ${list}, Position ${position} von ${total}.`,
      transferDrop: ({ label, list, position, total }: ListMove) => `${label} abgelegt in ${list}, Position ${position} von ${total}.`,
      transferCancel: ({ label, list, position, total }: ListMove) =>
        `Abgebrochen. ${label} bleibt in ${list}, Position ${position} von ${total}.`,
      sortable: "sortierbare Liste",
      movable: "verschiebbar",
      ontoGrab: ({ label, target, index, total }: { label: string; target: string; index: number; total: number }) =>
        `${label} aufgenommen. Ziel: ${target}, ${index} von ${total}. Pfeiltasten wählen das Ziel, Enter legt ab, Escape bricht ab.`,
      ontoGrabPointer: ({ label }: { label: string }) => `${label} aufgenommen. Über einem Ziel loslassen.`,
      ontoTarget: ({ target, index, total }: { target: string; index: number; total: number }) => `${target}, ${index} von ${total}.`,
      ontoDrop: ({ label, target }: { label: string; target: string }) => `${label} verschoben nach ${target}.`,
      ontoCancel: "Abgebrochen, nichts geändert.",
      listResults: ({ count }: { count: number }) => (count === 1 ? "1 Treffer" : `${count} Treffer`),
      listEmpty: "Keine Treffer",
      listRemoved: ({ label }: { label: string }) => `${label} entfernt`,
      loading: "Wird geladen",
      width: ({ px }: { px: number }) => `${px} px`,
    },
  },
});

export type BehaviorMessages = ReturnType<(typeof behaviorMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useBehaviorMessages = (): (() => BehaviorMessages) => {
  const locale = useLocale();
  return () => behaviorMessages.resolve([locale()]).t;
};

export const checkBehaviorMessages = () => behaviorMessages.check();
