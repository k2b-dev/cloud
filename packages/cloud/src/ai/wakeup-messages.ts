import { i18n } from "@k2b/stdlib";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      origin: "Alarm",
      forbidden: "You cannot manage alarms in this chat with this access. Open your own chat with unrestricted access.",
      not_found: "The chat or alarm is unavailable. Open the chat again.",
      limit: "This chat already has five alarms. Change or delete one first.",
      conflict: "The alarm changed. Open the list again before saving.",
      queue_full: "Too many scheduled messages are waiting in this chat. Wait for one to be sent, or remove one from the queue.",
      invalid: "Check the time, repeat schedule and note. Times must be in the future; repeating alarms end within 30 days.",
      snooze_limit: "Gustav has already postponed this alarm three times. Set a new time yourself if needed.",
    },
    de: {
      origin: "Wecker",
      forbidden:
        "Mit diesem Zugang kannst du in diesem Chat keine Wecker verwalten. Öffne deinen eigenen Chat mit uneingeschränktem Zugang.",
      not_found: "Der Chat oder Wecker ist nicht verfügbar. Öffne den Chat erneut.",
      limit: "Dieser Chat hat schon fünf Wecker. Ändere oder lösche zuerst einen davon.",
      conflict: "Der Wecker wurde geändert. Öffne die Liste vor dem Speichern erneut.",
      queue_full:
        "In diesem Chat warten schon zu viele geplante Nachrichten. Warte, bis eine gesendet wurde, oder entferne eine aus der Warteschlange.",
      invalid:
        "Prüfe Zeit, Wiederholung und Notiz. Die Zeit muss in der Zukunft liegen; wiederkehrende Wecker enden innerhalb von 30 Tagen.",
      snooze_limit: "Gustav hat diesen Wecker schon dreimal verschoben. Stelle bei Bedarf selbst eine neue Zeit ein.",
    },
  },
});
export const aiWakeupMessages = (locale: string) => messages.resolve([locale]).t;
