import { i18n } from "@k2b/stdlib";

/** Texts of the queued messages, loaded only with the queue so the chat's own bundle does not carry them. */
export const queueMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      queued: "Queued",
      queuedMessages: "Queued messages",
      sending: "Sending…",
      sendNow: "Send now",
      retrySendNow: "Send again",
      remove: "Remove",
      notSent: "Not sent",
      dispatchRetrying: "Could not start. Retrying shortly.",
      dispatchFailed: "Could not start. Please retry or remove.",
      order: "In order.",
      showAllShort: "Show all",
      showAll: ({ count }: { count: number }) =>
        i18n.plural(count, "en", { one: "Show the queued message", other: `Show all ${count} queued messages` }),
      fromAutomation: ({ name }: { name: string }) => `Automation “${name}”`,
      fromChat: ({ name }: { name: string }) => `Chat “${name}”`,
      announce: ({ text }: { text: string }) => `Queued: ${text}`,
      edit: "Edit",
      replaceDraft: "Replace the current draft with this queued message?",
    },
    de: {
      queued: "Vorgemerkt",
      queuedMessages: "Vorgemerkte Nachrichten",
      sending: "Wird gesendet …",
      sendNow: "Jetzt senden",
      retrySendNow: "Erneut senden",
      remove: "Entfernen",
      notSent: "Nicht gesendet",
      dispatchRetrying: "Start fehlgeschlagen. Neuer Versuch folgt.",
      dispatchFailed: "Start fehlgeschlagen. Bitte erneut versuchen oder entfernen.",
      order: "Der Reihe nach.",
      showAllShort: "Alle zeigen",
      showAll: ({ count }) =>
        i18n.plural(count, "de", { one: "Vorgemerkte Nachricht zeigen", other: `Alle ${count} vorgemerkten Nachrichten zeigen` }),
      fromAutomation: ({ name }) => `Automation „${name}“`,
      fromChat: ({ name }) => `Chat „${name}“`,
      announce: ({ text }) => `Vorgemerkt: ${text}`,
      edit: "Bearbeiten",
      replaceDraft: "Den aktuellen Entwurf durch diese vorgemerkte Nachricht ersetzen?",
    },
  },
});
