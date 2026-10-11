import { i18n } from "@k2b/stdlib";

const markdownInfoBlockMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      infoBlockNote: "Note",
      infoBlockInfo: "Info",
      infoBlockSuccess: "Success",
      infoBlockWarning: "Warning",
      infoBlockDanger: "Danger",
    },
    de: {
      infoBlockNote: "Notiz",
      infoBlockInfo: "Info",
      infoBlockSuccess: "Erfolg",
      infoBlockWarning: "Warnung",
      infoBlockDanger: "Gefahr",
    },
  },
});

export type MarkdownInfoBlockMessages = ReturnType<(typeof markdownInfoBlockMessages)["resolve"]>["t"];

/** Imperative UI inherits the document locale when no locale is supplied. */
export const resolveMarkdownInfoBlockMessages = (locale?: string): MarkdownInfoBlockMessages =>
  markdownInfoBlockMessages.resolve([
    locale ?? (typeof document === "undefined" ? markdownInfoBlockMessages.baseLocale : document.documentElement.lang),
  ]).t;

export const checkMarkdownInfoBlockMessages = () => markdownInfoBlockMessages.check();
