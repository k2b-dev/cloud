import { i18n } from "@k2b/stdlib";

export const sharedWorkstationMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      label: "Shared workstation",
      description: "Signs out after a while without input",
      markedTitle: "Shared workstation on",
      marked: ({ minutes }: { minutes: number }) => `Signs out after ${minutes} minutes without input and when the browser closes.`,
      unmarked: "This browser is no longer a shared workstation.",
      failed: "The shared workstation could not be changed. Try again.",
      warningTitle: "You will be signed out soon",
      warningBody: ({ seconds }: { seconds: number }) =>
        `Nobody has worked here for a while. So that nobody else sees your data at this shared workstation, you will be signed out in ${seconds} seconds.`,
      keepWorking: "Keep working",
      signOut: "Sign out",
    },
    de: {
      label: "Gemeinsam genutzter Arbeitsplatz",
      description: "Meldet ab, wenn hier eine Weile niemand arbeitet",
      markedTitle: "Gemeinsam genutzter Arbeitsplatz an",
      marked: ({ minutes }) => `Meldet nach ${minutes} Minuten ohne Eingabe und beim Schließen des Browsers ab.`,
      unmarked: "Dieser Browser ist kein gemeinsam genutzter Arbeitsplatz mehr.",
      failed: "Der gemeinsam genutzte Arbeitsplatz konnte nicht geändert werden. Bitte versuche es erneut.",
      warningTitle: "Du wirst gleich abgemeldet",
      warningBody: ({ seconds }) =>
        `Hier hat eine Weile niemand gearbeitet. Damit an diesem gemeinsam genutzten Arbeitsplatz niemand deine Daten sieht, wirst du in ${seconds} Sekunden abgemeldet.`,
      keepWorking: "Weiterarbeiten",
      signOut: "Abmelden",
    },
  },
});
