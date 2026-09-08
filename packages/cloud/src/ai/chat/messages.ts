import { i18n } from "@k2b/stdlib";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
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
