import { i18n } from "@k2b/stdlib";

/**
 * Short outcomes the v2 admin screens share as toasts. A v2 toast is one sentence (its message is its title); a
 * screen with more to say, such as the server's reason for a refusal, words that sentence itself.
 */
export const adminToasts = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      cacheCleared: "Cache cleared",
      cacheNotCleared: "Cache not cleared",
      notRedeliverable: "No longer deliverable",
      notQueued: "Not queued",
      pdfRendered: ({ size }: { size: string }) => `PDF rendered (${size})`,
      keySaved: "Key saved",
      notRemoved: "Not removed",
      freeIpaReachable: "FreeIPA reachable",
      testFailed: "Test failed",
      removed: "Removed",
    },
    de: {
      cacheCleared: "Cache geleert",
      cacheNotCleared: "Cache nicht geleert",
      notRedeliverable: "Nicht mehr zustellbar",
      notQueued: "Nicht eingereiht",
      pdfRendered: ({ size }) => `PDF erzeugt (${size})`,
      keySaved: "Schlüssel gespeichert",
      notRemoved: "Nicht entfernt",
      freeIpaReachable: "FreeIPA erreichbar",
      testFailed: "Test fehlgeschlagen",
      removed: "Entfernt",
    },
  },
});

export const checkAdminToastMessages = () => adminToasts.check();
