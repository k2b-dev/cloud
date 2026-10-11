import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const selectMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      chooseOption: "Choose option",
      filterOptions: "Filter options",
      noResultsFound: "No results found",
      noOptions: "No options available",
      optionsCouldNotLoad: "Options could not be loaded",
      searchOptions: "Search options",
      selectMatchingOption: "Select a matching option",
      selectOption: "Select option",
      checkingOptions: "Checking options",
      checkingOptionsLoading: "Checking options...",
      noMatchingOption: "No matching option found",
      noOptionsFound: "No options found",
      typeToSearch: "Type to search...",
      showGridView: "Show grid view",
      showListView: "Show list view",
      moreSelected: ({ count }: { count: number }) => `${count} more selected`,
      removeNamed: ({ name }: { name: string }) => `Remove ${name}`,
    },
    de: {
      chooseOption: "Option auswählen",
      filterOptions: "Optionen filtern",
      noResultsFound: "Keine Ergebnisse gefunden",
      noOptions: "Keine Optionen verfügbar",
      optionsCouldNotLoad: "Optionen konnten nicht geladen werden",
      searchOptions: "Optionen durchsuchen",
      selectMatchingOption: "Eine passende Option auswählen",
      selectOption: "Option auswählen",
      checkingOptions: "Optionen werden geprüft",
      checkingOptionsLoading: "Optionen werden geprüft...",
      noMatchingOption: "Keine passende Option gefunden",
      noOptionsFound: "Keine Optionen gefunden",
      typeToSearch: "Zum Suchen tippen...",
      showGridView: "Rasteransicht anzeigen",
      showListView: "Listenansicht anzeigen",
      moreSelected: ({ count }) => `${count} weitere ${count === 1 ? "Option" : "Optionen"} ausgewählt`,
      removeNamed: ({ name }) => `${name} entfernen`,
    },
  },
});

export type SelectMessages = ReturnType<(typeof selectMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useSelectMessages = (): (() => SelectMessages) => {
  const locale = useLocale();
  return () => selectMessages.resolve([locale()]).t;
};

/** Imperative UI inherits the document locale when no locale is supplied. */
export const resolveSelectMessages = (locale?: string): SelectMessages =>
  selectMessages.resolve([locale ?? (typeof document === "undefined" ? selectMessages.baseLocale : document.documentElement.lang)]).t;

export const checkSelectMessages = () => selectMessages.check();
