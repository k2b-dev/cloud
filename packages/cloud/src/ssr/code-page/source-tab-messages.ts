import { i18n } from "@k2b/stdlib";

type Count = { added: number; removed: number };
type Version = { number: number };

const linesDe = (count: number) => (count === 1 ? "1 Zeile" : `${count} Zeilen`);
const linesEn = (count: number) => (count === 1 ? "1 line" : `${count} lines`);

/** The Code tab of the own Code page: read-only source of the version that is switched on, optionally compared. */
export const sourceTabMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      fieldLabel: "Code",
      compareLabel: "Compare with",
      compareNone: "Nothing",
      compareNoneHint: "the code alone",
      compareVersion: ({ number }: Version) => `Version ${number}`,
      compareSubmitted: ({ date }: { date: string }) => `submitted ${date}`,
      stat: ({ added, removed }: Count) => `${linesEn(added)} added, ${linesEn(removed)} removed`,
      announceDiff: ({ number, added, removed }: Version & Count) =>
        `Compared with version ${number}: ${linesEn(added)} added, ${linesEn(removed)} removed`,
      announceCode: "The code of the version that is switched on",
      codeLabel: "Code of the version that is switched on, read only",
      diffLabel: ({ number }: Version) => `Difference from version ${number}, read only`,
      footCode: "Read only: the code of the version that is switched on. Change it with Gustav or on your own computer with",
      footDiff: ({ number }: Version) =>
        `Read only: the difference between version ${number} and the version that is switched on. Red is gone, green is new.`,
      footOne: "Read only. There is only this one version; comparing needs an earlier one.",
      noneTitle: "No version is switched on yet.",
      noneText: "As soon as a version is switched on, its code shows here.",
      noneAction: "Go to versions",
      error: "This changes nothing about the automation. Overview, runs and versions are not affected.",
      tooLarge: "This difference is too large to show here. Nothing changes about the automation.",
    },
    de: {
      fieldLabel: "Code",
      compareLabel: "Vergleichen mit",
      compareNone: "Nichts",
      compareNoneHint: "nur der Code",
      compareVersion: ({ number }) => `Version ${number}`,
      compareSubmitted: ({ date }) => `vom ${date}`,
      stat: ({ added, removed }) => `${linesDe(added)} dazu, ${linesDe(removed)} weg`,
      announceDiff: ({ number, added, removed }) => `Vergleich mit Version ${number}: ${linesDe(added)} dazu, ${linesDe(removed)} weg`,
      announceCode: "Der Code der eingeschalteten Version",
      codeLabel: "Code der eingeschalteten Version, nur lesen",
      diffLabel: ({ number }) => `Unterschied zu Version ${number}, nur lesen`,
      footCode: "Nur lesen: der Code der eingeschalteten Version. Ändern geht mit Gustav oder am eigenen Rechner mit",
      footDiff: ({ number }) =>
        `Nur lesen: der Unterschied zwischen Version ${number} und der eingeschalteten Version. Rot ist weg, grün ist neu.`,
      footOne: "Nur lesen. Es gibt erst diese eine Version; zum Vergleichen fehlt eine frühere.",
      noneTitle: "Es ist noch keine Version eingeschaltet.",
      noneText: "Sobald eine Version eingeschaltet ist, steht ihr Code hier.",
      noneAction: "Zu den Versionen",
      error: "An der Automation ändert das nichts. Übersicht, Läufe und Versionen sind davon nicht betroffen.",
      tooLarge: "Dieser Unterschied ist zu groß, um ihn hier zu zeigen. An der Automation ändert das nichts.",
    },
  },
});

export type SourceTabMessages = ReturnType<(typeof sourceTabMessages)["resolve"]>["t"];
