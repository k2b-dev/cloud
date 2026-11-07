import { i18n } from "@k2b/stdlib";

const messages = i18n.define({
  baseLocale: "en",
  messages: { en: { total: "Total", change: "Change" }, de: { total: "Gesamt", change: "Änderung" } },
});
export const categoryLabels = (locale = "en") => messages.resolve([locale]).t;
