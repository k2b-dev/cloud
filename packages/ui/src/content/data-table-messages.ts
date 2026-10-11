import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const dataTableMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      dataTable: "Data table",
      noColumns: "No columns.",
      noRecords: "No records",
    },
    de: {
      dataTable: "Datentabelle",
      noColumns: "Keine Spalten.",
      noRecords: "Keine Einträge",
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
