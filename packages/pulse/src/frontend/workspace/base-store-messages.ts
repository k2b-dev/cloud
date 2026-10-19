import { i18n } from "@k2b/stdlib";

/** Strings for a base's own store state in the base settings: lifecycle, usage, limits and retention confirmation. */
export const baseStoreMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      storeTitle: "Data store",
      storeDescription: "This base has its own database. A Cloud admin sets its limits.",
      state: "State",
      stateProvisioning: "Being set up",
      stateActive: "Active",
      stateClearing: "Being cleared",
      stateDeleting: "Being deleted",
      stateFailed: "Failed",
      stateWriteBlocked: "Writes blocked",
      failedProvision: "Setting up the database failed. Pulse continues where it stopped when you retry.",
      failedClear: "Clearing the data failed. Pulse continues where it stopped when you retry.",
      failedDelete: "Deleting the base failed. Pulse continues where it stopped when you retry.",
      busyText: "Pulse is working on this base. Writing waits until it is active again.",
      blockedText:
        "Pulse found a different checkpoint in the data store, for example after a restore. It keeps the data and accepts no new values until a Cloud admin decides.",
      retry: "Retry",
      retryStarted: "Pulse continues where it stopped.",
      retryFailed: "Retry did not start. Nothing changed. Try again.",
      usage: "Storage",
      usageOf: (p: { used: string; limit: string }) => `${p.used} of ${p.limit}`,
      notMeasured: "Not measured yet",
      measured: "measured",
      limits: "Limits",
      limitsSummary: (p: { values: string; series: string; profile: string }) =>
        `${p.values} values per minute · ${p.series} series · query profile ${p.profile}`,
      profileSmall: "small",
      profileNormal: "normal",
      profileLarge: "large",
      confirmShorterTitle: "Delete older data?",
      confirmShorterIntro: "The shorter retention removes data for good. Pulse deletes it in the background.",
      confirmRaw: (p: { rows: string; bytes: string; date: string }) => `Raw data before ${p.date}: ${p.rows} rows, about ${p.bytes}`,
      confirmRollup: (p: { rows: string; bytes: string; date: string }) =>
        `Hourly values before ${p.date}: ${p.rows} rows, about ${p.bytes}`,
      confirmSensitive: (p: { rows: string; bytes: string; date: string }) =>
        `Sensitive fields before ${p.date}: ${p.rows} rows, about ${p.bytes}`,
      confirmShorter: "Delete and save",
    },
    de: {
      storeTitle: "Datenspeicher",
      storeDescription: "Diese Base hat eine eigene Datenbank. Ihre Grenzen legt ein Cloud-Admin fest.",
      state: "Zustand",
      stateProvisioning: "Wird eingerichtet",
      stateActive: "Aktiv",
      stateClearing: "Wird geleert",
      stateDeleting: "Wird gelöscht",
      stateFailed: "Fehlgeschlagen",
      stateWriteBlocked: "Schreiben gesperrt",
      failedProvision:
        "Die Datenbank konnte nicht eingerichtet werden. Beim erneuten Versuch macht Pulse dort weiter, wo es aufgehört hat.",
      failedClear: "Die Daten konnten nicht geleert werden. Beim erneuten Versuch macht Pulse dort weiter, wo es aufgehört hat.",
      failedDelete: "Die Base konnte nicht gelöscht werden. Beim erneuten Versuch macht Pulse dort weiter, wo es aufgehört hat.",
      busyText: "Pulse arbeitet an dieser Base. Schreiben wartet, bis sie wieder aktiv ist.",
      blockedText:
        "Pulse hat im Datenspeicher einen anderen Prüfpunkt gefunden, zum Beispiel nach einer Wiederherstellung. Die Daten bleiben, neue Werte nimmt Pulse erst an, wenn ein Cloud-Admin entschieden hat.",
      retry: "Erneut versuchen",
      retryStarted: "Pulse macht dort weiter, wo es aufgehört hat.",
      retryFailed: "Der erneute Versuch ist nicht gestartet. Es wurde nichts geändert. Versuche es erneut.",
      usage: "Speicher",
      usageOf: (p: { used: string; limit: string }) => `${p.used} von ${p.limit}`,
      notMeasured: "Noch nicht gemessen",
      measured: "gemessen",
      limits: "Grenzen",
      limitsSummary: (p: { values: string; series: string; profile: string }) =>
        `${p.values} Werte pro Minute · ${p.series} Serien · Profil ${p.profile}`,
      profileSmall: "klein",
      profileNormal: "normal",
      profileLarge: "groß",
      confirmShorterTitle: "Ältere Daten löschen?",
      confirmShorterIntro: "Die kürzere Aufbewahrung löscht Daten endgültig. Pulse löscht sie im Hintergrund.",
      confirmRaw: (p: { rows: string; bytes: string; date: string }) => `Rohdaten vor dem ${p.date}: ${p.rows} Zeilen, etwa ${p.bytes}`,
      confirmRollup: (p: { rows: string; bytes: string; date: string }) =>
        `Stundenwerte vor dem ${p.date}: ${p.rows} Zeilen, etwa ${p.bytes}`,
      confirmSensitive: (p: { rows: string; bytes: string; date: string }) =>
        `Sensible Felder vor dem ${p.date}: ${p.rows} Zeilen, etwa ${p.bytes}`,
      confirmShorter: "Löschen und speichern",
    },
  },
});
export type BaseStoreMessages = ReturnType<typeof baseStoreMessages.resolve>["t"];
