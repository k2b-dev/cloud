import { i18n } from "@k2b/stdlib";

export const privacyScreenMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Privacy screen",
      howToContinue: "Click or press a key to continue working.",
      keepWorking: "Continue working",
      notALock: "Hides content, does not lock.",
      on: "Privacy screen on.",
      onAfterIdle: "Privacy screen on because you have not used Cloud for a while.",
      off: "Privacy screen off.",
      newMessages: "New messages. They stay hidden until you continue working.",
      soon: "Privacy screen soon",
      countdown: ({ seconds }: { seconds: number }) => `Privacy screen in ${seconds} seconds. A key or a mouse movement stops it.`,
      timer: "Hide automatically",
      timerOff: "Off",
      timerSeconds: ({ seconds }: { seconds: number }) => `${seconds} s`,
      timerMinutes: ({ minutes }: { minutes: number }) => `${minutes} min`,
      timerAfter: ({ value }: { value: string }) => `after ${value}`,
      retry: "Try again",
      commandNow: "Privacy screen now",
      commandNowDescription: "Hides content, does not lock.",
      commandTimer: "Set privacy screen timer",
      commandTimerDescription: ({ value }: { value: string }) => `Profile settings › At your screen · now: ${value}`,
      keywords: "privacy hide blur shoulder screen timer automatic",
    },
    de: {
      title: "Sichtschutz",
      howToContinue: "Klicke oder drücke eine Taste, um weiterzuarbeiten.",
      keepWorking: "Weiterarbeiten",
      notALock: "Verdeckt Inhalte, sperrt nicht.",
      on: "Sichtschutz an.",
      onAfterIdle: "Sichtschutz an, weil du Cloud eine Weile nicht benutzt hast.",
      off: "Sichtschutz aus.",
      newMessages: "Neue Mitteilungen. Sie bleiben verdeckt, bis du weiterarbeitest.",
      soon: "Sichtschutz gleich",
      countdown: ({ seconds }) => `Sichtschutz in ${seconds} Sekunden. Eine Taste oder Mausbewegung hält ihn auf.`,
      timer: "Automatisch verdecken",
      timerOff: "Aus",
      timerSeconds: ({ seconds }) => `${seconds} s`,
      timerMinutes: ({ minutes }) => `${minutes} min`,
      timerAfter: ({ value }) => `nach ${value}`,
      retry: "Erneut versuchen",
      commandNow: "Sichtschutz jetzt",
      commandNowDescription: "Verdeckt Inhalte, sperrt nicht.",
      commandTimer: "Sichtschutz-Timer einstellen",
      commandTimerDescription: ({ value }) => `Profileinstellungen › Am Bildschirm · jetzt: ${value}`,
      keywords: "privacy verdecken blur schulter bildschirm timer automatisch",
    },
  },
});

export type PrivacyScreenMessages = ReturnType<typeof privacyScreenMessages.resolve>["t"];

/** The short label of a timer choice, as the segmented row shows it: "Aus", "30 s", "2 min". */
export const privacyTimerLabel = (t: PrivacyScreenMessages, seconds: number): string =>
  seconds === 0 ? t.timerOff : seconds < 60 ? t.timerSeconds({ seconds }) : t.timerMinutes({ minutes: seconds / 60 });

/** The timer as a sentence part: "aus" or "nach 2 min". */
export const privacyTimerPhrase = (t: PrivacyScreenMessages, seconds: number): string =>
  seconds === 0 ? t.timerOff.toLocaleLowerCase() : t.timerAfter({ value: privacyTimerLabel(t, seconds) });
