import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const filterMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      filterActions: "Filter actions",
      filters: "Filters",
      reset: "Reset",
      all: "All",
      none: "None",
      allOf: ({ label }: { label: string }) => `Choose all of ${label}`,
      noneOf: ({ label }: { label: string }) => `Choose none of ${label}`,
      only: "Only",
      onlyOption: ({ label }: { label: string }) => `Only ${label}`,
    },
    de: {
      filterActions: "Filteraktionen",
      filters: "Filter",
      reset: "Zurücksetzen",
      all: "Alle",
      none: "Keine",
      allOf: ({ label }) => `Alle aus ${label} wählen`,
      noneOf: ({ label }) => `Keine aus ${label} wählen`,
      only: "Nur diese",
      onlyOption: ({ label }) => `Nur ${label}`,
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
