import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const filterMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      filterActions: "Filter actions",
      filters: "Filters",
      reset: "Reset",
    },
    de: {
      filterActions: "Filteraktionen",
      filters: "Filter",
      reset: "Zurücksetzen",
    },
  },
});

export type FilterMessages = ReturnType<(typeof filterMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useFilterMessages = (): (() => FilterMessages) => {
  const locale = useLocale();
  return () => filterMessages.resolve([locale()]).t;
};

export const checkFilterMessages = () => filterMessages.check();
