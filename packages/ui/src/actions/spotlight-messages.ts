import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const spotlightMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      spotlightNoResults: "No results.",
    },
    de: {
      spotlightNoResults: "Keine Ergebnisse.",
    },
  },
});

export type SpotlightMessages = ReturnType<(typeof spotlightMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useSpotlightMessages = (): (() => SpotlightMessages) => {
  const locale = useLocale();
  return () => spotlightMessages.resolve([locale()]).t;
};

/** Imperative UI inherits the document locale when no locale is supplied. */
export const resolveSpotlightMessages = (locale?: string): SpotlightMessages =>
  spotlightMessages.resolve([locale ?? (typeof document === "undefined" ? spotlightMessages.baseLocale : document.documentElement.lang)]).t;

export const checkSpotlightMessages = () => spotlightMessages.check();
