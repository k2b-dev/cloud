import { i18n } from "@k2b/stdlib";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      GEO_NOT_CONFIGURED: "An administrator must configure the Geoapify key in Core settings.",
      GEO_FORBIDDEN: "Sign in with a person, agent, or service account to use geo queries.",
      GEO_BUDGET_EXHAUSTED: "The geo budget is exhausted. Wait until resetsAt or ask an administrator to review the budget.",
      GEO_BUSY: "Geo queries are busy. Retry after retryAfterSeconds; if this persists, ask an administrator to check Valkey.",
      GEO_LIMIT_EXCEEDED: "Reduce the named input to the reported limit.",
      GEO_UNSUPPORTED_OPTION: "Choose supported options and one search area or address representation.",
      GEO_ADDRESS_NOT_FOUND: "No plausible address was found. Check the address or add a city and country.",
      GEO_ADDRESS_AMBIGUOUS: "Several addresses are plausible. Ask the person to choose a candidate or refine the address.",
      GEO_PROVIDER_FAILED:
        "The geo provider could not complete the request. Check costs before retrying; an administrator can check the key when adminHint is present.",
    },
    de: {
      GEO_NOT_CONFIGURED: "Ein Administrator muss den Geoapify-Schlüssel in den Core-Einstellungen eintragen.",
      GEO_FORBIDDEN: "Melde dich mit einem Personen-, Agenten- oder Dienstkonto für Geo-Abfragen an.",
      GEO_BUDGET_EXHAUSTED: "Das Geo-Budget ist aufgebraucht. Warte bis resetsAt oder bitte einen Administrator, das Budget zu prüfen.",
      GEO_BUSY:
        "Geo-Abfragen sind ausgelastet. Versuche es nach retryAfterSeconds erneut. Hält das an, sollte ein Administrator Valkey prüfen.",
      GEO_LIMIT_EXCEEDED: "Reduziere die genannte Eingabe auf die angegebene Grenze.",
      GEO_UNSUPPORTED_OPTION: "Wähle unterstützte Optionen und genau ein Suchgebiet oder Adressformat.",
      GEO_ADDRESS_NOT_FOUND: "Keine plausible Adresse gefunden. Prüfe die Adresse oder ergänze Ort und Land.",
      GEO_ADDRESS_AMBIGUOUS: "Mehrere Adressen sind plausibel. Lass die Person einen Vorschlag wählen oder die Adresse genauer angeben.",
      GEO_PROVIDER_FAILED:
        "Der Geo-Anbieter konnte die Anfrage nicht abschließen. Prüfe vor einem neuen Versuch die Kosten. Bei adminHint kann ein Administrator den Schlüssel prüfen.",
    },
  },
});
export const geoCapabilityMessages = (locale: string) => messages.resolve([locale]).t;
