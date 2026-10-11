import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const logEntriesMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      noLogEntries: "No log entries found.",
    },
    de: {
      noLogEntries: "Keine Logeinträge gefunden.",
    },
  },
});

export type LogEntriesMessages = ReturnType<(typeof logEntriesMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useLogEntriesMessages = (): (() => LogEntriesMessages) => {
  const locale = useLocale();
  return () => logEntriesMessages.resolve([locale()]).t;
};

export const checkLogEntriesMessages = () => logEntriesMessages.check();
