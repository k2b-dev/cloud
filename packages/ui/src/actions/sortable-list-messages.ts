import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

type Place = { position: number; count: number; list: string };

const sortableListMessages = /* @__PURE__ */ i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      handle: ({ label }: { label: string }) => `Move ${label}`,
      hint: "Drag, or press Space, then the arrow keys and Enter.",
      position: ({ position, count, list }: Place) => `Position ${position} of ${count} in “${list}”.`,
      statusPlace: ({ position, list }: { position: number; list: string }) => `to “${list}”, place ${position} · Esc cancels`,
      statusStay: "stays where it is · Esc cancels",
      moveTo: "Move to",
    },
    de: {
      handle: ({ label }: { label: string }) => `${label} verschieben`,
      hint: "Ziehen, oder Leertaste, dann Pfeiltasten und Enter.",
      position: ({ position, count, list }: Place) => `Position ${position} von ${count} in „${list}“.`,
      statusPlace: ({ position, list }: { position: number; list: string }) => `nach „${list}“, Platz ${position} · Esc bricht ab`,
      statusStay: "bleibt an seinem Platz · Esc bricht ab",
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
