import { i18n } from "@k2b/stdlib";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      tableLinks: "Links",
      tableOpen: "Open",
      tableEmpty: "No matching rows.",
      tableCapped: "Showing the first 100 returned rows. The full tool result remains available in details.",
      tableMore: "More rows are available. Ask for the next page or open the result in the application.",
      assistantTurns: "Assistant turns",
      workSteps: "Work steps",
      surveyNoAnswer: "No answer",
      surveyNoAnswers: "No answers submitted.",
      toolCalls: "Tool calls",
      toolIssues: "Tool issues",
      none: "None",
      read: "Read",
      byteRange: ({ start, end }: { start: string; end: string }) => `Bytes ${start}–${end}`,
    },
    de: {
      tableLinks: "Links",
      tableOpen: "Öffnen",
      tableEmpty: "Keine passenden Zeilen.",
      tableCapped:
        "Die ersten 100 zurückgegebenen Zeilen werden angezeigt. Das vollständige Werkzeugergebnis bleibt in den Details verfügbar.",
      tableMore: "Weitere Zeilen sind verfügbar. Frage nach der nächsten Seite oder öffne das Ergebnis in der Anwendung.",
      assistantTurns: "Antwortdurchläufe",
      workSteps: "Arbeitsschritte",
      surveyNoAnswer: "Keine Antwort",
      surveyNoAnswers: "Keine Antworten abgegeben.",
      toolCalls: "Werkzeugaufrufe",
      toolIssues: "Werkzeugprobleme",
      none: "Keine",
      read: "Gelesen",
      byteRange: ({ start, end }) => `Bytes ${start}–${end}`,
    },
  },
});

export const aiChatMessages = (locale: string) => messages.resolve([locale]).t;
export const checkAiChatMessages = () => messages.check();
