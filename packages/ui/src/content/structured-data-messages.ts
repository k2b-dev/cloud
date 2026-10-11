import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const structuredDataMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      viewRaw: "View raw",
      viewFormatted: "View formatted",
    },
    de: {
      viewRaw: "Rohdaten anzeigen",
      viewFormatted: "Formatiert anzeigen",
    },
  },
});

export type StructuredDataMessages = ReturnType<(typeof structuredDataMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useStructuredDataMessages = (): (() => StructuredDataMessages) => {
  const locale = useLocale();
  return () => structuredDataMessages.resolve([locale()]).t;
};

export const checkStructuredDataMessages = () => structuredDataMessages.check();
