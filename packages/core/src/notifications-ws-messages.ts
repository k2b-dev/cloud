import { i18n } from "@k2b/stdlib";

const catalog = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      loginRequired: "Login required",
      accessRefreshFailed: "Notification access refresh failed",
      capacityExceeded: "Notification updates exceeded the connection capacity",
      streamEnded: "Notification event stream ended",
      streamFailed: "Notification event stream failed",
      invalidJson: "Invalid JSON payload",
      invalidSubscription: "Invalid notification subscription",
      tooManyMessages: "Too many pending notification messages",
      subscriptionFailed: "Notification subscription failed",
    },
    de: {
      loginRequired: "Anmeldung erforderlich",
      accessRefreshFailed: "Die Zugriffsprüfung für Benachrichtigungen ist fehlgeschlagen",
      capacityExceeded: "Die Benachrichtigungen haben die Kapazität der Verbindung überschritten",
      streamEnded: "Der Benachrichtigungsstrom wurde beendet",
      streamFailed: "Der Benachrichtigungsstrom ist fehlgeschlagen",
      invalidJson: "Die JSON-Daten sind ungültig",
      invalidSubscription: "Die Benachrichtigungsanmeldung ist ungültig",
      tooManyMessages: "Zu viele ausstehende Benachrichtigungsnachrichten",
      subscriptionFailed: "Die Benachrichtigungsanmeldung ist fehlgeschlagen",
    },
  },
});

export type NotificationWsMessages = ReturnType<typeof catalog.resolve>["t"];
export const notificationWsMessages = (locale?: string | null) => catalog.resolve(locale ? [locale] : []).t;
export const checkNotificationWsMessages = () => catalog.check();
