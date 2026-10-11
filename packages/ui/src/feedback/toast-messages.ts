import { i18n } from "@k2b/stdlib";

const toastMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      dismissNotification: "Dismiss notification",
      notifications: "Notifications",
    },
    de: {
      dismissNotification: "Benachrichtigung schließen",
      notifications: "Benachrichtigungen",
    },
  },
});

export type ToastMessages = ReturnType<(typeof toastMessages)["resolve"]>["t"];

/** Imperative UI inherits the document locale when no locale is supplied. */
export const resolveToastMessages = (locale?: string): ToastMessages =>
  toastMessages.resolve([locale ?? (typeof document === "undefined" ? toastMessages.baseLocale : document.documentElement.lang)]).t;

export const checkToastMessages = () => toastMessages.check();
