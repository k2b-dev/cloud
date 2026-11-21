import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

type Place = { position: number; count: number; list: string };

const sortableListMessages = /* @__PURE__ */ i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      handle: ({ label }: { label: string }) => `Move ${label}`,
      hint: "Drag, or press Space, then the arrow keys and Enter. The arrow keys alone move one step.",
      moved: ({ label, position, count }: { label: string; position: number; count: number }) =>
        `${label}, position ${position} of ${count}.`,
      position: ({ position, count, list }: Place) => `Position ${position} of ${count} in “${list}”.`,
      statusPlace: ({ position, list }: { position: number; list: string }) => `to “${list}”, place ${position} · Esc cancels`,
      statusStay: "stays where it is · Esc cancels",
      moveTo: "Move to",
      unavailable: "Moving by keyboard is not available right now. Reload the page and try again.",
    },
    de: {
      handle: ({ label }: { label: string }) => `${label} verschieben`,
      hint: "Ziehen, oder Leertaste, dann Pfeiltasten und Enter. Pfeiltasten allein verschieben um einen Schritt.",
      moved: ({ label, position, count }: { label: string; position: number; count: number }) =>
        `${label}, Position ${position} von ${count}.`,
      position: ({ position, count, list }: Place) => `Position ${position} von ${count} in „${list}“.`,
      statusPlace: ({ position, list }: { position: number; list: string }) => `nach „${list}“, Platz ${position} · Esc bricht ab`,
      statusStay: "bleibt an seinem Platz · Esc bricht ab",
      moveTo: "Verschieben nach",
      unavailable: "Verschieben mit der Tastatur geht gerade nicht. Lade die Seite neu und versuch es noch einmal.",
    },
  },
});

export type SortableListMessages = ReturnType<(typeof sortableListMessages)["resolve"]>["t"];
export const useSortableListMessages = (): (() => SortableListMessages) => {
  const locale = useLocale();
  return () => sortableListMessages.resolve([locale()]).t;
};
export const checkSortableListMessages = () => sortableListMessages.check();
