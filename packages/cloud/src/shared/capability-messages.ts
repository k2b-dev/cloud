import { i18n } from "@k2b/stdlib";
import { DEFAULT_LOCALE } from "./locale";

const catalog = i18n.define({
  baseLocale: DEFAULT_LOCALE,
  messages: {
    en: {
      actionOutcomeUnknown: "The Action response was lost and its outcome is unknown; do not retry automatically",
      appCouldNotServe: ({ appId }: { appId: string }) => `App ${appId} could not serve the capability`,
      appUnavailable: ({ appId }: { appId: string }) => `App ${appId} is not currently available`,
      catalogLimit: ({ max }: { max: number }) => `Capability catalog limit must be between 1 and ${max}`,
      cloudUnavailable: "Cloud is unavailable",
      deadlineExceeded: "The capability deadline was exceeded",
      idempotencyInvalid: "Idempotency-Key is invalid",
      idempotencyNotAllowed: "This Action does not support idempotent retries; omit Idempotency-Key",
      idempotencyOnlyActions: "Idempotency-Key is only valid for Actions that require it",
      idempotencyRequired: "This Action requires an Idempotency-Key",
      inputNotSerializable: "Capability input must be JSON-serializable",
      inputSchemaMismatch: "Capability input did not match the registered schema",
      invalidCapabilityError: ({ appId }: { appId: string }) => `App ${appId} returned an invalid capability error`,
      invalidCapabilityJson: ({ appId }: { appId: string }) => `App ${appId} returned invalid or oversized capability JSON`,
      notFound: ({ kind, reference }: { kind: string; reference: string }) => `${kind} ${reference} not found`,
      outsideResultSchema: ({ appId }: { appId: string }) => `App ${appId} returned data outside its registered capability schema`,
      query: "Query",
      action: "Action",
      review: "Review",
      registryUnavailable: "Capability registry is currently unavailable",
      requestBodyJson: "Capability request body must be JSON",
      requestCancelled: "Capability request was cancelled",
      issuanceFailed: "Capability invocation issuance failed",
      requestInputOnly: "Capability request must contain only an input field",
      requestTooLarge: "Capability request is too large",
      unsupportedSchema: ({ appId }: { appId: string }) => `App ${appId} registered an unsupported capability schema`,
    },
    de: {
      actionOutcomeUnknown: "Die Antwort der Action ging verloren und ihr Ergebnis ist unbekannt; nicht automatisch erneut ausführen",
      appCouldNotServe: ({ appId }) => `App ${appId} konnte die Capability nicht ausführen`,
      appUnavailable: ({ appId }) => `App ${appId} ist derzeit nicht verfügbar`,
      catalogLimit: ({ max }) => `Das Limit des Capability-Katalogs muss zwischen 1 und ${max} liegen`,
      cloudUnavailable: "Cloud ist nicht verfügbar",
      deadlineExceeded: "Das Zeitlimit der Capability wurde überschritten",
      idempotencyInvalid: "Der Idempotency-Key ist ungültig",
      idempotencyNotAllowed: "Diese Action unterstützt keine idempotenten Wiederholungen; Idempotency-Key weglassen",
      idempotencyOnlyActions: "Ein Idempotency-Key ist nur für Actions gültig, die ihn voraussetzen",
      idempotencyRequired: "Diese Action benötigt einen Idempotency-Key",
      inputNotSerializable: "Die Capability-Eingabe muss als JSON serialisierbar sein",
      inputSchemaMismatch: "Die Capability-Eingabe entspricht nicht dem registrierten Schema",
      invalidCapabilityError: ({ appId }) => `App ${appId} hat einen ungültigen Capability-Fehler zurückgegeben`,
      invalidCapabilityJson: ({ appId }) => `App ${appId} hat ungültiges oder zu großes Capability-JSON zurückgegeben`,
      notFound: ({ kind, reference }) => `${kind} ${reference} wurde nicht gefunden`,
      outsideResultSchema: ({ appId }) => `App ${appId} hat Daten außerhalb ihres registrierten Capability-Schemas zurückgegeben`,
      query: "Query",
      action: "Action",
      review: "Prüfung",
      registryUnavailable: "Das Capability-Register ist derzeit nicht verfügbar",
      requestBodyJson: "Der Capability-Request-Body muss JSON enthalten",
      requestCancelled: "Die Capability-Anfrage wurde abgebrochen",
      issuanceFailed: "Die Berechtigung für den Capability-Aufruf konnte nicht ausgestellt werden",
      requestInputOnly: "Die Capability-Anfrage darf nur ein input-Feld enthalten",
      requestTooLarge: "Die Capability-Anfrage ist zu groß",
      unsupportedSchema: ({ appId }) => `App ${appId} hat ein nicht unterstütztes Capability-Schema registriert`,
    },
  },
});

export type CapabilityMessages = ReturnType<(typeof catalog)["resolve"]>["t"];

export const capabilityMessages = (locale?: string | null): CapabilityMessages => catalog.resolve(locale ? [locale] : []).t;

export const checkCapabilityMessages = () => catalog.check();
