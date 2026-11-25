import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** The words of Menu, Popover and Toast, resolved from the inherited render locale. */
const overlayMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { moreActions: "More actions", undo: "Undo", actionsFor: ({ name }: { name: string }) => `Actions for ${name}` },
    de: { moreActions: "Weitere Aktionen", undo: "Rückgängig", actionsFor: ({ name }: { name: string }) => `Aktionen für ${name}` },
  },
});

export type OverlayMessages = ReturnType<(typeof overlayMessages)["resolve"]>["t"];

export const useOverlayMessages = (): (() => OverlayMessages) => {
  const locale = useLocale();
  return () => overlayMessages.resolve([locale()]).t;
};

export const checkOverlayMessages = () => overlayMessages.check();
