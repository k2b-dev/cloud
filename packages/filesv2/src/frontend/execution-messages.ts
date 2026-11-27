import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";

export const executionMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Execution in Files",
      actor: "Performed by",
      via: "Via",
      action: "Recorded action",
      result: "Result in Files",
      done: "Completed",
      time: "Recorded at",
      before: "Before",
      after: "After",
      then: "then",
      references: "Source context and references",
      request: "Request reference",
      invocation: "Invocation reference",
      callingApp: "Calling application",
      origin: "Source",
      originAssistant: "Assistant",
      originMcp: "MCP",
      originHttp: "HTTP",
      originApp: "Application",
      originChoice: "A person's choice",
      unknownSource: "Other source",
      started: "Started",
      finished: "Finished",
      failed: "This run could not be loaded. Activity stays as it is.",
      missing: "This run is not there, or you may not see it.",
      close: "Close",
    },
    de: {
      title: "Ausführung in Dateien",
      actor: "Ausgeführt von",
      via: "Über",
      action: "Aufgezeichnete Aktion",
      result: "Ergebnis in Dateien",
      done: "Abgeschlossen",
      time: "Aufgezeichnet am",
      before: "Vorher",
      after: "Nachher",
      then: "damals",
      references: "Quellkontext und Referenzen",
      request: "Request-Referenz",
      invocation: "Invocation-Referenz",
      callingApp: "Aufrufende Anwendung",
      origin: "Quelle",
      originAssistant: "Assistant",
      originMcp: "MCP",
      originHttp: "HTTP",
      originApp: "Anwendung",
      originChoice: "Wahl einer Person",
      unknownSource: "Andere Quelle",
      started: "Begonnen",
      finished: "Beendet",
      failed: "Dieser Lauf konnte nicht geladen werden. Die Aktivität bleibt, wie sie ist.",
      missing: "Diesen Lauf gibt es nicht, oder du darfst ihn nicht sehen.",
      close: "Schließen",
    },
  },
});

export function useExecutionMessages() {
  const locale = useLocale();
  return () => executionMessages.resolve([locale()]).t;
}
