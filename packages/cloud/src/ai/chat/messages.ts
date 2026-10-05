import { i18n } from "@k2b/stdlib";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      backgroundRun: "Background run",
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
      createdPdf: "Created PDF",
      thinking: "Thinking",
      showReasoning: "Show reasoning",
      byteRange: ({ start, end }: { start: string; end: string }) => `Bytes ${start}–${end}`,
      streamLoginRequired: "Your session has ended. Sign in again to continue this chat.",
      streamAccessDenied: "You no longer have access to this chat.",
      streamNotFound: "This chat is no longer available.",
    },
    de: {
      backgroundRun: "Hintergrundlauf",
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
      createdPdf: "PDF erstellt",
      thinking: "Denkt nach",
      showReasoning: "Denkprozess anzeigen",
      byteRange: ({ start, end }) => `Bytes ${start}–${end}`,
      streamLoginRequired: "Deine Sitzung ist abgelaufen. Melde dich erneut an, um diesen Chat fortzusetzen.",
      streamAccessDenied: "Du hast keinen Zugriff mehr auf diesen Chat.",
      streamNotFound: "Dieser Chat ist nicht mehr verfügbar.",
    },
  },
});

export const aiChatMessages = (locale: string) => messages.resolve([locale]).t;
export const checkAiChatMessages = () => messages.check();
