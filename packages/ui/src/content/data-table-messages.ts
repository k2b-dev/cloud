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
    },
    de: {
      dataTable: "Datentabelle",
      noColumns: "Keine Spalten.",
      noRecords: "Keine Einträge",
      loadingRows: "Zeilen werden geladen",
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
