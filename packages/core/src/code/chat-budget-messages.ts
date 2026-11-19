import { i18n } from "@k2b/stdlib";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      unpricedModel: ({ automation, model }: { automation: string; model: string }) =>
        `“${automation}” cannot write to this chat: no price is configured for the model ${model}. Without a price, a daily budget cannot be enforced. An administrator can enter the price.`,
      reason: (code: string): string => {
        if (code === "code_ai_turn_exceeds_daily_budget")
          return "This model’s maximum turn cost exceeds the Code daily budget. Choose a less expensive model or ask your administrator to adjust the Code budget.";
        if (code === "code_ai_daily_budget_limit" || code === "code_ai_owner_daily_budget_limit")
          return "The daily Code AI budget is spent or reserved by running work. This message has failed; a later scheduled run can try again.";
        if (code === "code_ai_budget_unknown")
          return "This model has no known maximum turn cost. Choose a model with known context and output limits.";
        if (code === "code_ai_budget_changed")
          return "The model or its price changed after this turn started. This turn cannot resume with the old reservation.";
        if (code === "code_ai_budget_settled") return "This Code turn has already ended and been accounted for. Start a new run.";
        return "Code chat admission failed.";
      },
    },
    de: {
      unpricedModel: ({ automation, model }: { automation: string; model: string }) =>
        `„${automation}“ kann nicht in diesen Chat schreiben: Für das Modell ${model} ist kein Preis hinterlegt. Ohne Preis gibt es kein Tagesbudget. Die Administration kann den Preis eintragen.`,
      reason: (code: string): string => {
        if (code === "code_ai_turn_exceeds_daily_budget")
          return "Der Höchstbetrag dieses Modells übersteigt das Code-Tagesbudget. Wähle ein günstigeres Modell oder bitte die Administration, das Code-Budget anzupassen.";
        if (code === "code_ai_daily_budget_limit" || code === "code_ai_owner_daily_budget_limit")
          return "Das KI-Tagesbudget des Codes ist verbraucht oder durch laufende Arbeit reserviert. Diese Nachricht ist gescheitert; ein späterer Zeitplan-Lauf kann es erneut versuchen.";
        if (code === "code_ai_budget_unknown")
          return "Für dieses Modell ist kein Höchstbetrag bekannt. Wähle ein Modell mit bekannten Kontext- und Ausgabegrenzen.";
        if (code === "code_ai_budget_changed")
          return "Das Modell oder sein Preis hat sich seit dem Zugstart geändert. Der Zug kann mit der bisherigen Reservierung nicht weiterlaufen.";
        if (code === "code_ai_budget_settled") return "Dieser Code-Zug ist bereits beendet und abgerechnet. Starte einen neuen Lauf.";
        return "Der Code-Chat konnte nicht starten.";
      },
    },
  },
});

export const codeChatBudgetMessages = (locale: string) => messages.resolve([locale]).t;
