import { i18n } from "@k2b/stdlib";

/**
 * The toasts of the v2 admin screens. A v2 toast shows one line, its title (toast-copy rule: at most three words), so
 * each names only the outcome; what a person needs beyond that, such as why a test failed, stays on the screen.
 */
export const adminToasts = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      cacheCleared: "Cache cleared",
      cacheNotCleared: "Cache not cleared",
      cleanedUp: "Cleaned up",
      notCleanedUp: "Not cleaned up",
      notRedeliverable: "No longer deliverable",
      notQueued: "Not queued",
      pdfRendered: ({ size }: { size: string }) => `PDF rendered (${size})`,
      logNotLoaded: "Log not loaded",
      contentNotLoaded: "Content not loaded",
      cancelled: "Cancelled",
      nothingWaiting: "Nothing was waiting",
      notCancelled: "Not cancelled",
      testEmailSent: "Test email sent",
      keySaved: "Key saved",
      notRemoved: "Not removed",
      jobStarted: "Job started",
      jobNotStarted: "Job not started",
      saved: "Saved",
      attributesAssigned: "Linux attributes assigned",
      freeIpaReachable: "FreeIPA reachable",
      addedReachable: "Added and reachable",
      addedTestFailed: "Added, test failed",
      testFailed: "Test failed",
    },
    de: {
      cacheCleared: "Cache geleert",
      cacheNotCleared: "Cache nicht geleert",
      cleanedUp: "Bereinigt",
      notCleanedUp: "Nicht bereinigt",
      notRedeliverable: "Nicht mehr zustellbar",
      notQueued: "Nicht eingereiht",
      pdfRendered: ({ size }) => `PDF erzeugt (${size})`,
      logNotLoaded: "Protokoll nicht geladen",
      contentNotLoaded: "Inhalt nicht geladen",
      cancelled: "Abgebrochen",
      nothingWaiting: "Nichts wartete mehr",
      notCancelled: "Nicht abgebrochen",
      testEmailSent: "Testmail gesendet",
      keySaved: "Schlüssel gespeichert",
      notRemoved: "Nicht entfernt",
      jobStarted: "Auftrag gestartet",
      jobNotStarted: "Auftrag nicht gestartet",
      saved: "Gespeichert",
      attributesAssigned: "Linux-Attribute vergeben",
      freeIpaReachable: "FreeIPA erreichbar",
      addedReachable: "Angelegt und erreichbar",
      addedTestFailed: "Angelegt, Test fehlgeschlagen",
      testFailed: "Test fehlgeschlagen",
    },
  },
});

export const checkAdminToastMessages = () => adminToasts.check();
