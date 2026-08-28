import { i18n } from "@k2b/stdlib";

export const prettyTableMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      suggestion: ({ value }: { value: string }) => `Suggestion: ${value}`,
      formulaName: "Formula",
      parseError: "Invalid formula",
      unknownFunction: ({ name }: { name: string }) => `Unknown function “${name}”`,
      unknownColumn: ({ name }: { name: string }) => `Unknown column “${name}”`,
      wrongArgumentCount: ({ name }: { name: string }) => `${name} received the wrong number of arguments`,
      nonNumeric: ({ name }: { name: string }) => `${name} requires a numeric value`,
      divisionByZero: ({ name }: { name: string }) => `${name} cannot divide by zero`,
      typeError: ({ name }: { name: string }) => `${name} received an incompatible value`,
      circularReference: ({ name }: { name: string }) => `Circular reference involving “${name}”`,
    },
    de: {
      suggestion: ({ value }) => `Vorschlag: ${value}`,
      formulaName: "Die Formel",
      parseError: "Ungültige Formel",
      unknownFunction: ({ name }) => `Unbekannte Funktion „${name}“`,
      unknownColumn: ({ name }) => `Unbekannte Spalte „${name}“`,
      wrongArgumentCount: ({ name }) => `${name} hat die falsche Anzahl an Argumenten erhalten`,
      nonNumeric: ({ name }) => `${name} benötigt einen Zahlenwert`,
      divisionByZero: ({ name }) => `${name} kann nicht durch null teilen`,
      typeError: ({ name }) => `${name} hat einen ungeeigneten Wert erhalten`,
      circularReference: ({ name }) => `Zirkelbezug mit „${name}“`,
    },
  },
});
