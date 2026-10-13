import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const tableOfContentsMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { title: "On this page" },
    de: { title: "Auf dieser Seite" },
  },
});
export const useTableOfContentsMessages = () => {
  const locale = useLocale();
  return () => tableOfContentsMessages.resolve([locale()]).t;
};
export const checkTableOfContentsMessages = () => tableOfContentsMessages.check();
