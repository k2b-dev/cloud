import { i18n } from "@k2b/stdlib";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      budget: (code: string): string => {
        if (code === "code_ai_turn_exceeds_daily_budget")
          return "This model’s maximum turn cost exceeds the daily automation budget. Choose a less expensive model or ask your administrator to adjust the budget.";
        if (code === "code_ai_budget_unknown")
          return "The model's context or output limits are missing. Ask your administrator to enter the limits in model management, or choose a model with known limits.";
        if (code === "code_ai_budget_changed")
          return "The model or its price changed after this response started. It cannot continue with the previous reservation.";
        if (code === "code_ai_budget_settled") return "This alarm response has already ended. Set another time if needed.";
        return "The daily automation budget is spent or reserved by running work. This alarm was missed. Open the alarm to catch it up or choose another time.";
      },
    },
    de: {
      budget: (code: string): string => {
        if (code === "code_ai_turn_exceeds_daily_budget")
          return "Der Höchstbetrag dieses Modells übersteigt das Tagesbudget für Automationen. Wähle ein günstigeres Modell oder bitte die Administration, das Budget anzupassen.";
        if (code === "code_ai_budget_unknown")
          return "Für das Modell fehlen Kontext- oder Ausgabegrenzen. Bitte die Administration, die Grenzen in der Modellverwaltung einzutragen, oder wähle ein Modell mit bekannten Grenzen.";
        if (code === "code_ai_budget_changed")
          return "Das Modell oder sein Preis hat sich seit dem Start dieser Antwort geändert. Sie kann mit der bisherigen Reservierung nicht weiterlaufen.";
        if (code === "code_ai_budget_settled") return "Diese Wecker-Antwort ist bereits beendet. Stelle bei Bedarf eine neue Zeit ein.";
        return "Das Tagesbudget für Automationen ist verbraucht oder durch laufende Arbeit reserviert. Dieser Wecker wurde verpasst. Öffne den Wecker, um ihn nachzuholen oder eine neue Zeit zu wählen.";
      },
    },
  },
});
export const aiWakeupMessages = (locale: string) => messages.resolve([locale]).t;
