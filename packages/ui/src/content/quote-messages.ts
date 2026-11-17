import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

// Only quotes use these, so composers and timelines that never quote carry none of them.
const quoteMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { quoteFrom: "Quote from", removeQuote: "Remove quote" },
    de: { quoteFrom: "Zitat von", removeQuote: "Zitat entfernen" },
  },
});

/** Resolved from the inherited render locale. */
export const useQuoteMessages = () => {
  const locale = useLocale();
  return () => quoteMessages.resolve([locale()]).t;
};

export const checkQuoteMessages = () => quoteMessages.check();
