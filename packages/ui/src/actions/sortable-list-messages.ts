import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

type Place = { position: number; count: number; list: string };

const sortableListMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      handle: ({ label }: { label: string }) => `Move ${label}`,
      hint: "Drag, or press Space to lift, the arrow keys to choose a place, Enter to drop, and Escape to cancel. The arrow keys alone move one step.",
      moved: ({ label, position, count }: { label: string; position: number; count: number }) =>
        `${label}, position ${position} of ${count}.`,
      lifted: ({ label, position, count, list }: Place & { label: string }) =>
        `${label} lifted. Position ${position} of ${count} in “${list}”. The arrow keys choose a place, Enter drops, Escape cancels.`,
      position: ({ position, count, list }: Place) => `Position ${position} of ${count} in “${list}”.`,
      dropped: ({ label, position, count, list }: Place & { label: string }) =>
        `${label} dropped, position ${position} of ${count} in “${list}”.`,
      cancelled: ({ label }: { label: string }) => `Cancelled. ${label} stays where it was.`,
      statusPlace: ({ position, list }: { position: number; list: string }) => `to “${list}”, place ${position} · Esc cancels`,
      statusPlaceKeyboard: ({ position, list }: { position: number; list: string }) =>
        `to “${list}”, place ${position} · Enter drops, Esc cancels`,
      moveTo: "Move to",
    },
    de: {
      handle: ({ label }: { label: string }) => `${label} verschieben`,
      hint: "Ziehen, oder: Leertaste hebt an, Pfeiltasten wählen den Platz, Eingabe legt ab, Escape bricht ab. Ohne Anheben verschieben die Pfeiltasten um einen Schritt.",
      moved: ({ label, position, count }: { label: string; position: number; count: number }) =>
        `${label}, Position ${position} von ${count}.`,
      lifted: ({ label, position, count, list }: Place & { label: string }) =>
        `${label} angehoben. Position ${position} von ${count} in „${list}“. Pfeiltasten wählen den Platz, Eingabe legt ab, Escape bricht ab.`,
      position: ({ position, count, list }: Place) => `Position ${position} von ${count} in „${list}“.`,
      dropped: ({ label, position, count, list }: Place & { label: string }) =>
        `${label} abgelegt, Position ${position} von ${count} in „${list}“.`,
      cancelled: ({ label }: { label: string }) => `Abgebrochen. ${label} bleibt an seinem Platz.`,
      statusPlace: ({ position, list }: { position: number; list: string }) => `nach „${list}“, Platz ${position} · Esc bricht ab`,
      statusPlaceKeyboard: ({ position, list }: { position: number; list: string }) =>
        `nach „${list}“, Platz ${position} · Eingabe legt ab, Esc bricht ab`,
      moveTo: "Verschieben nach",
    },
  },
});

export type SortableListMessages = ReturnType<(typeof sortableListMessages)["resolve"]>["t"];
export const useSortableListMessages = (): (() => SortableListMessages) => {
  const locale = useLocale();
  return () => sortableListMessages.resolve([locale()]).t;
};
export const checkSortableListMessages = () => sortableListMessages.check();
