import { i18n } from "@k2b/stdlib";
import type { FormComputedDiagnostic } from "./form-computed-fields";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      missing: "A summary formula refers to a missing field. Update its field references.",
      ambiguous: "A summary formula has an ambiguous field reference. Use a unique field name or ID.",
      hidden: "A summary formula needs a field that is not a visible form input. Add that input or choose another formula.",
      unsupported: "A summary formula uses a relation, lookup or other unsupported field type. Use only values entered in this form.",
      cycle: "Summary formulas depend on each other in a cycle. Remove the circular reference.",
      syntax: "A summary formula has invalid syntax. Correct the formula before adding it.",
      duplicate: "The same formula is selected more than once. Remove the duplicate summary entry.",
      target: "Only formula fields can be selected for the calculated summary.",
    },
    de: {
      missing: "Eine Summenformel verweist auf ein fehlendes Feld. Aktualisiere ihre Feldverweise.",
      ambiguous: "Ein Feldverweis in einer Summenformel ist mehrdeutig. Verwende einen eindeutigen Feldnamen oder eine eindeutige ID.",
      hidden:
        "Eine Summenformel benötigt ein Feld, das keine sichtbare Formulareingabe ist. Füge die Eingabe hinzu oder wähle eine andere Formel.",
      unsupported:
        "Eine Summenformel verwendet eine Relation, einen Lookup oder einen anderen nicht unterstützten Feldtyp. Verwende nur Werte aus den Formulareingaben.",
      cycle: "Summenformeln hängen im Kreis voneinander ab. Entferne den zirkulären Verweis.",
      syntax: "Eine Summenformel hat eine ungültige Syntax. Korrigiere die Formel, bevor du sie hinzufügst.",
      duplicate: "Dieselbe Formel wurde mehrfach ausgewählt. Entferne den doppelten Eintrag in der Zusammenfassung.",
      target: "Für die berechnete Zusammenfassung können nur Formelfelder ausgewählt werden.",
    },
  },
});

export const formComputedDiagnosticMessage = (code: FormComputedDiagnostic, locale?: string): string =>
  messages.resolve(locale ? [locale] : []).t[code];
