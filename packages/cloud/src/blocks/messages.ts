import { i18n } from "@k2b/stdlib";

/** Cloud's own words around app blocks: choice states, empty lists, yes and no. The blocks' labels are the app's. */
export const blockMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      yes: "Yes",
      no: "No",
      chosenCount: ({ count }: { count: number }) => (count === 0 ? "Nothing chosen yet" : `${count.toLocaleString("en")} chosen`),
      chosenByYou: ({ time }: { time?: string }) => (time ? `Chosen by you · ${time}` : "Chosen by you"),
      busy: "Gustav is still answering. You can choose afterwards.",
      superseded: "No longer open. A newer answer replaced this question.",
      choiceFailed: "Your choice didn't go through. Try again.",
      emptyCards: "Nothing to show.",
      before: "before",
      openLarge: "Open large",
      showData: "Show data",
      fromApp: ({ app }: { app: string }) => `From ${app}`,
      chosenIn: ({ app }: { app: string }) => `Chosen in ${app}`,
      close: "Close",
      search: "Search",
      link: "Link",
      open: "Open",
    },
    de: {
      yes: "Ja",
      no: "Nein",
      chosenCount: ({ count }) => (count === 0 ? "Noch nichts gewählt" : `${count.toLocaleString("de")} gewählt`),
      chosenByYou: ({ time }) => (time ? `Von dir gewählt · ${time}` : "Von dir gewählt"),
      busy: "Gustav antwortet noch. Danach kannst du wählen.",
      superseded: "Nicht mehr offen. Eine neuere Antwort hat diese Frage ersetzt.",
      choiceFailed: "Deine Wahl ging nicht durch. Versuche es noch einmal.",
      emptyCards: "Nichts zu zeigen.",
      before: "vorher",
      openLarge: "Groß öffnen",
      showData: "Daten zeigen",
      fromApp: ({ app }) => `Von ${app}`,
      chosenIn: ({ app }) => `Gewählt in ${app}`,
      close: "Schließen",
      search: "Suchen",
      link: "Link",
      open: "Öffnen",
    },
  },
});

export const blockWords = (locale: string) => blockMessages.resolve([locale]).t;
