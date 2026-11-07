import { i18n } from "@k2b/stdlib";

/** Words a description panel adds around the host's data. Titles, labels and empty sentences come from the host. */
export const descriptionMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      nothingToShow: "Nothing to show for this period.",
      nothingCounted: "Nothing counted in this period",
      asOfNotCurrent: ({ asOf }: { asOf: string }) => `As of ${asOf} · not current`,
      notCurrent: "Not current",
      cannotShow: "This view cannot be shown here.",
      table: "Table",
      search: "Search",
      searchIn: ({ title }: { title: string }) => `Search ${title}`,
      groupIn: ({ title }: { title: string }) => `Group ${title}`,
      notGrouped: "Not grouped",
      groupBy: ({ label }: { label: string }) => `By ${label}`,
      noRowContains: ({ query }: { query: string }) => `No row contains “${query}”.`,
      clearSearch: "Clear search",
    },
    de: {
      nothingToShow: "In diesem Zeitraum gibt es nichts zu zeigen.",
      nothingCounted: "In diesem Zeitraum nichts gezählt",
      asOfNotCurrent: ({ asOf }) => `Stand ${asOf} · nicht aktuell`,
      notCurrent: "Nicht aktuell",
      cannotShow: "Diese Ansicht kann hier nicht gezeigt werden.",
      table: "Tabelle",
      search: "Suchen",
      searchIn: ({ title }) => `${title} durchsuchen`,
      groupIn: ({ title }) => `${title} gruppieren`,
      notGrouped: "Nicht gruppiert",
      groupBy: ({ label }) => `Nach ${label}`,
      noRowContains: ({ query }) => `Keine Zeile enthält „${query}“.`,
      clearSearch: "Suche leeren",
    },
  },
});
export type DescriptionMessages = ReturnType<typeof descriptionMessages.resolve>["t"];
