import { i18n } from "@k2b/stdlib";

/** Preview copy loads with the complete proposal, rather than the initial approval frame. */
export const actionDetailsMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      fullReviewLoading: "Loading the complete proposal …",
      fullReviewRetry: "Try again",
      readMoreTitle: "Opens exactly this version",
      changes: "What changes",
    },
    de: {
      fullReviewLoading: "Der vollständige Vorschlag wird geladen …",
      fullReviewRetry: "Noch einmal versuchen",
      readMoreTitle: "Öffnet genau diese Fassung",
      changes: "Was sich ändert",
    },
  },
});
