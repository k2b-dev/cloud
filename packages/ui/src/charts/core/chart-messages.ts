import { i18n } from "@k2b/stdlib";

/** Labels needed by pure SVG renderers; UI inspection messages stay with the UI host. */
export const coreChartMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { series: "Series", areaTotal: "Total" },
    de: { series: "Datenreihe", areaTotal: "Zusammen" },
  },
});
