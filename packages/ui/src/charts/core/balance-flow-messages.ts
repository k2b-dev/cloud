/** Kind-owned chart messages, shared by the pure renderer, table and interaction host. */
import { balanceFlowFields } from "./balance-flow-fields";

const messages = {
  en: {
    balanceOpening: "Opening",
    balanceClosing: "Closing",
    balanceInflows: "Inflows",
    balanceOutflows: "Outflows",
    balanceBalance: "Balance",
    balanceAvailable: "Available",
    balanceOwed: "owed",
    balancePrevious: "Previous period",
    balanceNext: "Next period",
    balanceEmpty: "No periods to show.",
    balanceInvalid: "The amounts do not balance. Check opening, inflows, outflows and closing.",
    balanceStale: "Showing the last loaded amounts.",
    balanceRetry: "Try again",
    balanceKeyboard: "←/→: period. ↑/↓: amounts. Enter: pin. Escape: close.",
    chartView: "Chart view",
    chartDiagram: "Diagram",
    chartData: "Table",
    chartLoading: "Loading …",
  },
  de: {
    balanceOpening: "Anfang",
    balanceClosing: "Schluss",
    balanceInflows: "Eingänge",
    balanceOutflows: "Ausgänge",
    balanceBalance: "Saldo",
    balanceAvailable: "Verfügbar",
    balanceOwed: "geschuldet",
    balancePrevious: "Vorheriger Zeitraum",
    balanceNext: "Nächster Zeitraum",
    balanceEmpty: "Keine Zeiträume vorhanden.",
    balanceInvalid: "Die Beträge gehen nicht auf. Anfang, Eingänge, Ausgänge und Schluss prüfen.",
    balanceStale: "Die zuletzt geladenen Beträge werden angezeigt.",
    balanceRetry: "Erneut versuchen",
    balanceKeyboard: "←/→: Zeitraum. ↑/↓: Beträge. Enter: festhalten. Escape: schließen.",
    chartView: "Diagrammansicht",
    chartDiagram: "Diagramm",
    chartData: "Tabelle",
    chartLoading: "Lädt …",
  },
};
export const balanceFlowWords = (locale = "en") => ({
  ...messages[locale.toLowerCase().split("-")[0] === "de" ? "de" : "en"],
  ...balanceFlowFields(locale),
});
