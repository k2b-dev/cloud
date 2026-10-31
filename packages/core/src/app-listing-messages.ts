import { i18n } from "@k2b/stdlib";

export const appListingMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      adminRequired: "Administrator access required",
      writeScopeRequired: "Write scope required",
      appRunning: "Running apps cannot be removed.",
      forgetFailed: "Not removed. Try again.",
    },
    de: {
      adminRequired: "Administratorzugriff erforderlich",
      writeScopeRequired: "Schreibberechtigung erforderlich",
      appRunning: "Laufende Apps können nicht entfernt werden.",
      forgetFailed: "Nicht entfernt. Erneut versuchen.",
    },
  },
});
