import { i18n } from "@k2b/stdlib";
import type { WebhookSendErrorCode } from "../service/webhooks";

export const webhookApiMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      bodyTooLarge: "Request body is too large",
      userBackedActorRequired: "Tools webhooks require a user-backed actor",
      endpointNotFound: "Webhook endpoint not found",
      endpointNotFoundShort: "Endpoint not found",
      defaultEndpointName: "Webhook endpoint",
      sendUnsupportedProtocol: "Only HTTP and HTTPS URLs are allowed.",
      sendCredentialsInUrl: "URLs with embedded credentials are not allowed.",
      sendBlockedTarget: "Private, local, and link-local targets are blocked.",
      sendLogFailed: "Outgoing request could not be logged.",
      requestFailed: "Request failed",
    },
    de: {
      bodyTooLarge: "Der Anfrageinhalt ist zu groß",
      userBackedActorRequired: "Für Tools-Webhooks ist ein Benutzerkonto erforderlich",
      endpointNotFound: "Webhook-Endpunkt wurde nicht gefunden",
      endpointNotFoundShort: "Endpunkt wurde nicht gefunden",
      defaultEndpointName: "Webhook-Endpunkt",
      sendUnsupportedProtocol: "Nur HTTP- und HTTPS-URLs sind erlaubt.",
      sendCredentialsInUrl: "URLs mit eingebetteten Zugangsdaten sind nicht erlaubt.",
      sendBlockedTarget: "Ziele in privaten, lokalen und link-lokalen Netzwerken sind blockiert.",
      sendLogFailed: "Die ausgehende Anfrage konnte nicht protokolliert werden.",
      requestFailed: "Anfrage fehlgeschlagen",
    },
  },
});

export type WebhookApiMessages = ReturnType<typeof webhookApiMessages.resolve>["t"];

/** Maps a stable send-path error code to its localized human-facing message. */
export const sendErrorMessage = (t: WebhookApiMessages, code: WebhookSendErrorCode): string => {
  switch (code) {
    case "UNSUPPORTED_PROTOCOL":
      return t.sendUnsupportedProtocol;
    case "CREDENTIALS_IN_URL":
      return t.sendCredentialsInUrl;
    case "BLOCKED_TARGET":
      return t.sendBlockedTarget;
    case "OUTGOING_LOG_FAILED":
      return t.sendLogFailed;
  }
};
