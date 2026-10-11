import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const iconMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      filterIcons: "Filter icons",
      pickIcon: "Pick an icon...",
    },
    de: {
      filterIcons: "Symbole filtern",
      pickIcon: "Symbol auswählen...",
    },
  },
});

export type IconMessages = ReturnType<(typeof iconMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useIconMessages = (): (() => IconMessages) => {
  const locale = useLocale();
  return () => iconMessages.resolve([locale()]).t;
};

export const checkIconMessages = () => iconMessages.check();
