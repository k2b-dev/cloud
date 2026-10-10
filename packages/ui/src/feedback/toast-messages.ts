import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

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

/** Resolved from the inherited render locale. */
export const useToastMessages = (): (() => ToastMessages) => {
  const locale = useLocale();
  return () => toastMessages.resolve([locale()]).t;
};

/** Imperative UI inherits the document locale when no locale is supplied. */
export const resolveToastMessages = (locale?: string): ToastMessages =>
  toastMessages.resolve([locale ?? (typeof document === "undefined" ? toastMessages.baseLocale : document.documentElement.lang)]).t;

export const checkToastMessages = () => toastMessages.check();
