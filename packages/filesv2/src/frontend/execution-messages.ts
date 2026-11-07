import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";

export const executionMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Execution in Files",
      scope:
        "This record shows one action and its recorded effect in Files, with the available source context. It does not describe the outcome of the whole originating run.",
      sourceUnavailable: "The source conversation is not available through this record.",
      actor: "Performed by",
      via: "Via",
      action: "Recorded action",
      result: "Result in Files",
      done: "Completed",
      time: "Recorded at",
      before: "Before",
      after: "After",
      snapshot: "Recorded path; this does not confirm its current location.",
      references: "Source context and references",
      referenceNote:
        "These references can help identify the request. They do not open the source conversation or establish the outcome of other actions.",
      request: "Request reference",
      invocation: "Invocation reference",
      callingApp: "Calling application",
      origin: "Source",
      originAssistant: "Assistant",
      originMcp: "MCP",
      originHttp: "HTTP",
      originApp: "Application",
      unknownSource: "Other source",
      started: "Started",
      finished: "Finished",
      failedTitle: "This execution record could not be loaded",
      failedText: "Try loading this Files record again in a moment.",
      retry: "Try again",
    },
    de: {
      title: "Ausführung in Dateien",
      scope:
        "Dieser Eintrag zeigt eine Aktion und ihre aufgezeichnete Wirkung in Dateien mit dem verfügbaren Quellkontext. Er beschreibt nicht den Ausgang der gesamten ursprünglichen Ausführung.",
      sourceUnavailable: "Die Quellkonversation ist über diesen Eintrag nicht verfügbar.",
      actor: "Ausgeführt von",
      via: "Über",
      action: "Aufgezeichnete Aktion",
      result: "Ergebnis in Dateien",
      done: "Abgeschlossen",
      time: "Aufgezeichnet am",
      before: "Vorher",
      after: "Nachher",
      snapshot: "Aufgezeichneter Pfad; der aktuelle Ort ist damit nicht bestätigt.",
      references: "Quellkontext und Referenzen",
      referenceNote:
        "Diese Referenzen helfen, den Aufruf zuzuordnen. Sie öffnen keine Quellkonversation und belegen nicht den Ausgang anderer Aktionen.",
      request: "Request-Referenz",
      invocation: "Invocation-Referenz",
      callingApp: "Aufrufende Anwendung",
      origin: "Quelle",
      originAssistant: "Assistant",
      originMcp: "MCP",
      originHttp: "HTTP",
      originApp: "Anwendung",
      unknownSource: "Andere Quelle",
      started: "Begonnen",
      finished: "Beendet",
      failedTitle: "Der Ausführungseintrag konnte nicht geladen werden",
      failedText: "Versuch gleich noch einmal, diesen Dateien-Eintrag zu laden.",
      retry: "Erneut versuchen",
    },
  },
});

export function useExecutionMessages() {
  const locale = useLocale();
  return () => executionMessages.resolve([locale()]).t;
}
