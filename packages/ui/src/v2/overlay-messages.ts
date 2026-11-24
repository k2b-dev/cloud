import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** The words of Menu, Popover and Toast, resolved from the inherited render locale. */
const overlayMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { moreActions: "More actions", notifications: "Notifications", undo: "Undo" },
    de: { moreActions: "Weitere Aktionen", notifications: "Meldungen", undo: "Rückgängig" },
  },
});

export type OverlayMessages = ReturnType<(typeof overlayMessages)["resolve"]>["t"];

export const useOverlayMessages = (): (() => OverlayMessages) => {
  const locale = useLocale();
  return () => overlayMessages.resolve([locale()]).t;
};

/** For code outside a component (`toast`), where no locale is inherited: the page's language. */
export const pageOverlayMessages = (): OverlayMessages =>
  overlayMessages.resolve([typeof document === "undefined" ? "en" : document.documentElement.lang || "en"]).t;

export const checkOverlayMessages = () => overlayMessages.check();
