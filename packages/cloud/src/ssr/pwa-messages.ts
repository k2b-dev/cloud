import { i18n } from "@k2b/stdlib";

/** Strings of the mobile app's frame: the tab bar, the offline notice and the account notice. */
export const pwaMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      tabs: "App",
      start: "Start",
      offline: "You're offline",
      otherAccount: ({ cloud, name }: { cloud: string; name: string }) =>
        `Chrome on this phone is signed in to ${cloud} as ${name}. Changes in the app may be saved to that account. Sign out of ${cloud} in Chrome.`,
      errorAction: "Back to Start",
    },
    de: {
      tabs: "App",
      start: "Start",
      offline: "Du bist offline",
      otherAccount: ({ cloud, name }: { cloud: string; name: string }) =>
        `Chrome auf diesem Telefon ist bei ${cloud} als ${name} angemeldet. Änderungen in der App werden womöglich in diesem Konto gespeichert. Melde dich in Chrome von ${cloud} ab.`,
      errorAction: "Zurück zum Start",
    },
  },
});
