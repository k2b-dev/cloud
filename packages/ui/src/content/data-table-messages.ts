import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const dataTableMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      dataTable: "Data table",
      noColumns: "No columns.",
      noRecords: "No records",
      loadingRows: "Loading rows",
      noMatch: ({ query }: { query: string }) => `No row matches “${query}”.`,
      clearSearch: "Clear search",
      details: "Details",
      showDetails: "Show the row's hidden values",
      rowCount: ({ count }: { count: number }) => (count === 1 ? "1 row" : `${count} rows`),
      search: "Search",
      searchTable: ({ label }: { label: string }) => `Search ${label}`,
      groupRows: "Group rows",
      notGrouped: "Not grouped",
      groupedBy: ({ label }: { label: string }) => `By ${label}`,
    },
    de: {
      dataTable: "Datentabelle",
      noColumns: "Keine Spalten.",
      noRecords: "Keine Einträge",
      loadingRows: "Zeilen werden geladen",
      noMatch: ({ query }: { query: string }) => `Keine Zeile passt zu „${query}“.`,
      clearSearch: "Suche löschen",
      details: "Details",
      showDetails: "Ausgeblendete Werte der Zeile zeigen",
      rowCount: ({ count }: { count: number }) => (count === 1 ? "1 Zeile" : `${count} Zeilen`),
      search: "Suchen",
      searchTable: ({ label }: { label: string }) => `${label} durchsuchen`,
      groupRows: "Zeilen gruppieren",
      notGrouped: "Nicht gruppiert",
      groupedBy: ({ label }: { label: string }) => `Nach ${label}`,
    },
  },
});

export type DataTableMessages = ReturnType<(typeof dataTableMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useDataTableMessages = (): (() => DataTableMessages) => {
  const locale = useLocale();
  return () => dataTableMessages.resolve([locale()]).t;
};

export const checkDataTableMessages = () => dataTableMessages.check();
