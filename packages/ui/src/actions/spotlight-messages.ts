import { i18n } from "@k2b/stdlib";

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

/** Imperative UI inherits the document locale when no locale is supplied. */
export const resolveSpotlightMessages = (locale?: string): SpotlightMessages =>
  spotlightMessages.resolve([locale ?? (typeof document === "undefined" ? spotlightMessages.baseLocale : document.documentElement.lang)]).t;

export const checkSpotlightMessages = () => spotlightMessages.check();
