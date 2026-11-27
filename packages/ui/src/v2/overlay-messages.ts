import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** The words of Menu, Popover and Toast, resolved from the inherited render locale. */
const overlayMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      moreActions: "More actions",
      more: "More",
      levelsAbove: "Levels above",
      moreInBar: "More in this bar",
      undo: "Undo",
      retry: "Try again",
      actionsFor: ({ name }: { name: string }) => `Actions for ${name}`,
      backTo: ({ name }: { name: string }) => `Back to ${name}`,
    },
    de: {
      moreActions: "Weitere Aktionen",
      more: "Mehr",
      levelsAbove: "Übergeordnete Ebenen",
      moreInBar: "Mehr in dieser Leiste",
      undo: "Rückgängig",
      retry: "Erneut versuchen",
      actionsFor: ({ name }: { name: string }) => `Aktionen für ${name}`,
      backTo: ({ name }: { name: string }) => `Zurück zu ${name}`,
    },
  },
});

export type OverlayMessages = ReturnType<(typeof overlayMessages)["resolve"]>["t"];

export const useOverlayMessages = (): (() => OverlayMessages) => {
  const locale = useLocale();
  return () => overlayMessages.resolve([locale()]).t;
};

export const checkOverlayMessages = () => overlayMessages.check();
