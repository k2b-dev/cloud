import { i18n } from "@k2b/stdlib";

/** Strings of the mobile app's frame: the tab bar, the offline notice and the account notice. */
export const pwaMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      tabs: "App",
      start: "Start",
      apps: "Apps",
      settings: "Settings",
      offline: "You're offline",
      newVersion: ({ cloud }: { cloud: string }) => `New version of ${cloud}`,
      reload: "Reload",
      otherAccount: ({ cloud, name }: { cloud: string; name: string }) =>
        `Chrome on this device is signed in to ${cloud} as ${name}. Changes in the app may be saved to that account. Sign out of ${cloud} in Chrome.`,
      errorAction: "Back to Start",
      partForbidden: ({ name }: { name: string }) => `${name} is not available to you`,
      partForbiddenDescription: ({ name }: { name: string }) => `Your administrators decide who may use ${name}. Ask them if you need it.`,
    },
    de: {
      tabs: "App",
      start: "Start",
      apps: "Apps",
      settings: "Einstellungen",
      offline: "Du bist offline",
      newVersion: ({ cloud }: { cloud: string }) => `Neue Version von ${cloud}`,
      reload: "Neu laden",
      otherAccount: ({ cloud, name }: { cloud: string; name: string }) =>
        `Chrome auf diesem Gerät ist bei ${cloud} als ${name} angemeldet. Änderungen in der App werden womöglich in diesem Konto gespeichert. Melde dich in Chrome von ${cloud} ab.`,
      errorAction: "Zum Start",
      partForbidden: ({ name }: { name: string }) => `${name} ist für dich nicht freigegeben`,
      partForbiddenDescription: ({ name }: { name: string }) =>
        `Wer ${name} nutzen darf, legt die Verwaltung fest. Frag dort nach, wenn du es brauchst.`,
    },
  },
});
