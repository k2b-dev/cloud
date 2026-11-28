import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** The words of Menu, Popover and Toast, resolved from the inherited render locale. */
const overlayMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      moreActions: "More actions",
      moreInBar: "More in this bar",
      create: "New",
      undo: "Undo",
      retry: "Try again",
      actionsFor: ({ name }: { name: string }) => `Actions for ${name}`,
      backTo: ({ name }: { name: string }) => `Back to ${name}`,
    },
    de: {
      moreActions: "Weitere Aktionen",
      moreInBar: "Mehr in dieser Leiste",
      create: "Neu",
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
