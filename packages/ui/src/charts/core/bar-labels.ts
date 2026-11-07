import { i18n } from "@k2b/stdlib";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      start: "of start",
      startShare: "Share of start",
      previousShare: "Share of previous step",
      rank: "Rank",
      more: ({ n }: { n: number }) => `${n} more`,
    },
    de: {
      start: "vom Start",
      startShare: "Anteil am Start",
      previousShare: "Anteil am vorigen Schritt",
      rank: "Rang",
      more: ({ n }: { n: number }) => `${n} weitere`,
    },
  },
});
export const barLabels = (locale = "en") => messages.resolve([locale]).t;
export const barPercent = (locale = "en") => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
