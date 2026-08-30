import { i18n } from "@k2b/stdlib";

const catalog = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      loginRequired: "Login required",
      accessDenied: "Access denied",
      mailboxNotFound: "Mailbox not found",
      accessRefreshFailed: "Mail access refresh failed",
      invalidStreamData: "Mail event stream contains invalid data",
      capacityExceeded: "Mail updates exceeded the connection capacity",
      streamEnded: "Mail event stream ended",
      streamFailed: "Mail event stream failed",
      invalidJson: "Invalid JSON payload",
      invalidSubscription: "Invalid Mail live subscription",
      tooManyMessages: "Too many pending Mail live messages",
      subscriptionFailed: "Mail live subscription failed",
    },
    de: {
      loginRequired: "Anmeldung erforderlich",
      accessDenied: "Zugriff verweigert",
      mailboxNotFound: "Das Postfach wurde nicht gefunden",
      accessRefreshFailed: "Die Zugriffsprüfung für Mail ist fehlgeschlagen",
      invalidStreamData: "Der Mail-Ereignisstrom enthält ungültige Daten",
      capacityExceeded: "Die Mail-Updates haben die Kapazität der Verbindung überschritten",
      streamEnded: "Der Mail-Ereignisstrom wurde beendet",
      streamFailed: "Der Mail-Ereignisstrom ist fehlgeschlagen",
      invalidJson: "Die JSON-Daten sind ungültig",
      invalidSubscription: "Die Live-Anmeldung für Mail ist ungültig",
      tooManyMessages: "Zu viele ausstehende Mail-Live-Nachrichten",
      subscriptionFailed: "Die Live-Anmeldung für Mail ist fehlgeschlagen",
    },
  },
});

export type MailWsMessages = ReturnType<typeof catalog.resolve>["t"];
export const mailWsMessages = (locale?: string | null) => catalog.resolve(locale ? [locale] : []).t;
export const checkMailWsMessages = () => catalog.check();
