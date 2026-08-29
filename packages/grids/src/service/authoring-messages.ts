import { i18n } from "@k2b/stdlib";

const authoringMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      formulaPreviewHint: "Type a formula to preview the latest records.",
      formulaSyntax: ({ detail }: { detail: string }) => `Parse error: ${detail}`,
      formulaUnknownField: ({ field }: { field: string }) => `Unknown field reference: ${field}`,
      formulaEvaluation: "Some preview rows return a formula error.",
      gqlSyntax: "The GQL syntax is invalid. Check the highlighted location.",
      gqlContext: "The GQL query context is incomplete or invalid.",
      gqlResolution: "The GQL query refers to an unknown or unavailable source, field, or alias.",
      gqlExecution: "The GQL query could not be executed.",
    },
    de: {
      formulaPreviewHint: "Gib eine Formel ein, um die neuesten Datensätze als Vorschau anzuzeigen.",
      formulaSyntax: (_args) => "Die Formel enthält einen Syntaxfehler. Prüfe die markierte Stelle.",
      formulaUnknownField: ({ field }) => `Unbekannter Feldverweis: ${field}`,
      formulaEvaluation: "Bei einigen Datensätzen tritt in der Vorschau ein Formelfehler auf.",
      gqlSyntax: "Die GQL-Syntax ist ungültig. Prüfe die markierte Stelle.",
      gqlContext: "Der GQL-Abfragekontext ist unvollständig oder ungültig.",
      gqlResolution: "Mindestens eine Quelle, ein Feld oder ein Alias der GQL-Abfrage ist unbekannt oder nicht verfügbar.",
      gqlExecution: "Die GQL-Abfrage konnte nicht ausgeführt werden.",
    },
  },
});

export const authoringText = (locale?: string) => authoringMessages.resolve([locale ?? "en"]).t;

export const isGermanAuthoringLocale = (locale?: string): boolean => {
  try {
    return new Intl.Locale(locale ?? "en").language === "de";
  } catch {
    return false;
  }
};
