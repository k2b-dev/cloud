import { i18n } from "@k2b/stdlib";

/** What a delivered view shows, in lists and in a tab's meta line, where a file would show its size. */
export const viewKindMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { chart: "Chart", group: "Charts", explorer: "Analysis", table: "Table", stats: "Key figures", details: "Details", view: "View" },
    de: {
      chart: "Diagramm",
      group: "Diagramme",
      explorer: "Auswertung",
      table: "Tabelle",
      stats: "Kennzahlen",
      details: "Angaben",
      view: "Ansicht",
    },
  },
});

/** The sign of a view delivered before Cloud recorded what it shows. */
export const GENERIC_VIEW_ICON = "ti ti-presentation-analytics";
