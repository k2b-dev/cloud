import { i18n } from "@k2b/stdlib";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      unknown: ({ value, field, options }: { value: string; field: string; options: string }) =>
        `Unknown option "${value}" in "${field}". Available options: ${options || "—"}.`,
      ambiguous: ({ value, field }: { value: string; field: string }) =>
        `Ambiguous option "${value}" in "${field}". Use its exact option ID.`,
      literal: ({ field }: { field: string }) => `Select "${field}" needs a literal option ID or label.`,
      comparison: ({ field }: { field: string }) => `Select "${field}" only supports =, != or HAS_OPTION.`,
      multiple: ({ field }: { field: string }) => `Use HAS_OPTION for multiple-select "${field}".`,
      membership: "HAS_OPTION needs a Select field and a literal option ID or label.",
      nonScalar: "A collection is not a scalar formula value. Join the related table and use its typed field.",
      coercion: ({ field }: { field: string }) =>
        `Use =, !=, ISBLANK or HAS_OPTION for Select "${field}"; text functions are not membership tests.`,
    },
    de: {
      unknown: ({ value, field, options }) => `Unbekannte Option „${value}“ in „${field}“. Verfügbare Optionen: ${options || "—"}.`,
      ambiguous: ({ value, field }) => `Mehrdeutige Option „${value}“ in „${field}“. Verwende die exakte Options-ID.`,
      literal: ({ field }) => `Das Auswahlfeld „${field}“ benötigt eine Options-ID oder Beschriftung als Textkonstante.`,
      comparison: ({ field }) => `Das Auswahlfeld „${field}“ unterstützt nur =, != oder HAS_OPTION.`,
      multiple: ({ field }) => `Verwende HAS_OPTION für die Mehrfachauswahl „${field}“.`,
      membership: "HAS_OPTION benötigt ein Auswahlfeld und eine Options-ID oder Beschriftung als Textkonstante.",
      nonScalar: "Eine Liste ist kein skalarer Formelwert. Verknüpfe die zugehörige Tabelle und verwende ihr typisiertes Feld.",
      coercion: ({ field }) =>
        `Verwende =, !=, ISBLANK oder HAS_OPTION für das Auswahlfeld „${field}“. Textfunktionen prüfen keine Auswahloptionen.`,
    },
  },
});

export const formulaSelectText = (locale?: string) => messages.resolve(locale ? [locale] : []).t;
