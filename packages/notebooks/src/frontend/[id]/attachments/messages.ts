import { i18n } from "@k2b/stdlib";

/** The attachments page's key figures. */
export const attachmentsPageMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      attachmentsFigure: "Attachments",
      addedIn: ({ count, days }: { count: string; days: number }) => `${count} new in ${days} days`,
      uploadsTrend: ({ days, count, today }: { days: number; count: string; today: string }) =>
        `${count} uploaded in ${days} days, ${today} today`,
      storage: "Storage",
    },
    de: {
      attachmentsFigure: "Anhänge",
      addedIn: ({ count, days }) => `${count} neu in ${days} Tagen`,
      uploadsTrend: ({ days, count, today }) => `${count} hochgeladen in ${days} Tagen, heute ${today}`,
      storage: "Speicher",
    },
  },
});
