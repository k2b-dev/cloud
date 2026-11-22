import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const dragAndDropMessages = /* @__PURE__ */ i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      pickedUp: ({ label }: { label: string }) => `${label} picked up. Drag it to a place and let go, or press Escape to cancel.`,
      over: ({ target }: { target: string }) => `Over ${target}.`,
      refused: ({ target, label }: { target: string; label: string }) => `${target} does not take ${label}.`,
      dropped: ({ label, target }: { label: string; target: string }) => `${label} dropped on ${target}.`,
      cancelled: ({ label }: { label: string }) => `${label} not moved.`,
      statusLead: ({ label, count }: { label: string; count: number }) =>
        count > 1 ? `${count} items are being moved` : `“${label}” is being moved`,
      statusOver: ({ target }: { target: string }) => `to “${target}” · Esc cancels`,
      statusIdle: "Esc cancels",
      unavailable: "Moving by keyboard is not available right now. Reload the page and try again.",
      overlayUnavailable: "The drop targets are not available right now. Use the menu of the item, or reload the page.",
    },
    de: {
      pickedUp: ({ label }: { label: string }) => `${label} angehoben. Zieh es an einen Ort und lass los, oder drück Escape zum Abbrechen.`,
      over: ({ target }: { target: string }) => `Über ${target}.`,
      refused: ({ target, label }: { target: string; label: string }) => `${target} nimmt ${label} nicht an.`,
      dropped: ({ label, target }: { label: string; target: string }) => `${label} auf ${target} abgelegt.`,
      cancelled: ({ label }: { label: string }) => `${label} nicht verschoben.`,
      statusLead: ({ label, count }: { label: string; count: number }) =>
        count > 1 ? `${count} Einträge werden verschoben` : `„${label}“ wird verschoben`,
      statusOver: ({ target }: { target: string }) => `nach „${target}“ · Esc bricht ab`,
      statusIdle: "Esc bricht ab",
      unavailable: "Verschieben mit der Tastatur geht gerade nicht. Lade die Seite neu und versuch es noch einmal.",
      overlayUnavailable: "Die Ziele zum Ablegen fehlen gerade. Nutze das Menü des Eintrags oder lade die Seite neu.",
    },
  },
});

export type DragAndDropMessages = ReturnType<(typeof dragAndDropMessages)["resolve"]>["t"];
export const useDragAndDropMessages = (): (() => DragAndDropMessages) => {
  const locale = useLocale();
  return () => dragAndDropMessages.resolve([locale()]).t;
};
export const checkDragAndDropMessages = () => dragAndDropMessages.check();
