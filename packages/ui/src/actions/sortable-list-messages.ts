import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const sortableListMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      handle: ({ label }: { label: string }) => `Move ${label}`,
      hint: "Drag, or use the arrow keys, to change the order.",
      moved: ({ label, position, count }: { label: string; position: number; count: number }) =>
        `${label}, position ${position} of ${count}.`,
    },
    de: {
      handle: ({ label }: { label: string }) => `${label} verschieben`,
      hint: "Ziehen oder mit den Pfeiltasten die Reihenfolge ändern.",
      moved: ({ label, position, count }: { label: string; position: number; count: number }) =>
        `${label}, Position ${position} von ${count}.`,
    },
  },
});

export type SortableListMessages = ReturnType<(typeof sortableListMessages)["resolve"]>["t"];
export const useSortableListMessages = (): (() => SortableListMessages) => {
  const locale = useLocale();
  return () => sortableListMessages.resolve([locale()]).t;
};
export const checkSortableListMessages = () => sortableListMessages.check();
