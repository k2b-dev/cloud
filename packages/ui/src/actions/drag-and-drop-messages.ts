import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const dragAndDropMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      pickedUp: ({ label }: { label: string }) => `${label} picked up. Drag it to a place and let go, or press Escape to cancel.`,
      pickedUpKeyboard: ({ label, count }: { label: string; count: number }) =>
        `${label} picked up. ${count === 1 ? "1 place takes it" : `${count} places take it`}. Arrow keys choose a place, Enter drops, Escape cancels.`,
      choice: ({ target, index, count }: { target: string; index: number; count: number }) => `${target}, ${index} of ${count}.`,
      over: ({ target }: { target: string }) => `Over ${target}.`,
      refused: ({ target, label }: { target: string; label: string }) => `${target} does not take ${label}.`,
      dropped: ({ label, target }: { label: string; target: string }) => `${label} dropped on ${target}.`,
      cancelled: ({ label }: { label: string }) => `${label} not moved.`,
      noTarget: ({ label }: { label: string }) => `No place here takes ${label}.`,
    },
    de: {
      pickedUp: ({ label }: { label: string }) => `${label} angehoben. Zieh es an einen Ort und lass los, oder drück Escape zum Abbrechen.`,
      pickedUpKeyboard: ({ label, count }: { label: string; count: number }) =>
        `${label} angehoben. ${count === 1 ? "1 Ort nimmt es an" : `${count} Orte nehmen es an`}. Pfeiltasten wählen einen Ort, Eingabe legt ab, Escape bricht ab.`,
      choice: ({ target, index, count }: { target: string; index: number; count: number }) => `${target}, ${index} von ${count}.`,
      over: ({ target }: { target: string }) => `Über ${target}.`,
      refused: ({ target, label }: { target: string; label: string }) => `${target} nimmt ${label} nicht an.`,
      dropped: ({ label, target }: { label: string; target: string }) => `${label} auf ${target} abgelegt.`,
      cancelled: ({ label }: { label: string }) => `${label} nicht verschoben.`,
      noTarget: ({ label }: { label: string }) => `Hier nimmt kein Ort ${label} an.`,
    },
  },
});

export type DragAndDropMessages = ReturnType<(typeof dragAndDropMessages)["resolve"]>["t"];
export const useDragAndDropMessages = (): (() => DragAndDropMessages) => {
  const locale = useLocale();
  return () => dragAndDropMessages.resolve([locale()]).t;
};
export const checkDragAndDropMessages = () => dragAndDropMessages.check();
