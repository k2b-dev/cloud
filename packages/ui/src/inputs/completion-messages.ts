import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const completionMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      suggestions: "Suggestions",
      suggestionsCouldNotLoad: "Suggestions could not be loaded",
      completionSuggestions: "Completion suggestions",
    },
    de: {
      suggestions: "Vorschläge",
      suggestionsCouldNotLoad: "Vorschläge konnten nicht geladen werden",
      completionSuggestions: "Vervollständigungsvorschläge",
    },
  },
});

export type CompletionMessages = ReturnType<(typeof completionMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useCompletionMessages = (): (() => CompletionMessages) => {
  const locale = useLocale();
  return () => completionMessages.resolve([locale()]).t;
};

export const checkCompletionMessages = () => completionMessages.check();
