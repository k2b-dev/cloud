import { i18n } from "@k2b/stdlib";

const catalog = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      loginRequired: "Login required",
      conversationAccessChanged: "Conversation access changed or expired",
      capacityExceeded: "AI updates exceeded the connection capacity",
      authorizationRefreshFailed: "AI live authorization refresh failed",
      invalidStreamData: "AI event stream contains invalid data",
      eventStreamEnded: "AI event stream ended",
      eventStreamFailed: "AI event stream failed",
      subscriptionFailed: "AI live subscription failed",
      conversationStreamEnded: "AI conversation stream ended",
      conversationStreamFailed: "AI conversation stream failed",
      liveSubscriptionRequired: "AI live subscription required before a turn subscription",
      conversationNotFound: "Conversation not found",
      invalidJson: "Invalid JSON payload",
      invalidSubscription: "Invalid AI live subscription",
      tooManyMessages: "Too many pending AI live messages",
    },
    de: {
      loginRequired: "Anmeldung erforderlich",
      conversationAccessChanged: "Der Zugriff auf die Unterhaltung wurde geändert oder ist abgelaufen",
      capacityExceeded: "Die AI-Updates haben die Kapazität der Verbindung überschritten",
      authorizationRefreshFailed: "Die Zugriffsprüfung für AI Live ist fehlgeschlagen",
      invalidStreamData: "Der AI-Ereignisstrom enthält ungültige Daten",
      eventStreamEnded: "Der AI-Ereignisstrom wurde beendet",
      eventStreamFailed: "Der AI-Ereignisstrom ist fehlgeschlagen",
      subscriptionFailed: "Die Anmeldung für AI Live ist fehlgeschlagen",
      conversationStreamEnded: "Der AI-Unterhaltungsstrom wurde beendet",
      conversationStreamFailed: "Der AI-Unterhaltungsstrom ist fehlgeschlagen",
      liveSubscriptionRequired: "Vor dem Abonnieren eines Durchlaufs ist eine Anmeldung für AI Live erforderlich",
      conversationNotFound: "Die Unterhaltung wurde nicht gefunden",
      invalidJson: "Die JSON-Daten sind ungültig",
      invalidSubscription: "Die Anmeldung für AI Live ist ungültig",
      tooManyMessages: "Zu viele ausstehende Nachrichten für AI Live",
    },
  },
});

export type AiLiveMessages = ReturnType<typeof catalog.resolve>["t"];
export const aiLiveMessages = (locale?: string | null) => catalog.resolve(locale ? [locale] : []).t;
export const checkAiLiveMessages = () => catalog.check();
