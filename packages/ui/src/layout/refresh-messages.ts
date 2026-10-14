import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const refreshMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      refreshing: "Refreshing",
    },
    de: {
      refreshing: "Wird aktualisiert",
    },
  },
});

export type RefreshMessages = ReturnType<(typeof refreshMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useRefreshMessages = (): (() => RefreshMessages) => {
  const locale = useLocale();
  return () => refreshMessages.resolve([locale()]).t;
};

export const checkRefreshMessages = () => refreshMessages.check();
