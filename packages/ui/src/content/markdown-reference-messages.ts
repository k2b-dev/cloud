import { i18n } from "@k2b/stdlib";

const markdownReferenceMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      referencePdf: "PDF",
      referenceImage: "Image",
      referenceDesign: "Design file",
      referenceFile: "File",
      referenceNote: "Note",
      referenceHeading: "Heading",
      referenceTask: "Task",
      referencePage: "Page",
    },
    de: {
      referencePdf: "PDF",
      referenceImage: "Bild",
      referenceDesign: "Designdatei",
      referenceFile: "Datei",
      referenceNote: "Notiz",
      referenceHeading: "Überschrift",
      referenceTask: "Aufgabe",
      referencePage: "Seite",
    },
  },
});

export type MarkdownReferenceMessages = ReturnType<(typeof markdownReferenceMessages)["resolve"]>["t"];

/** Imperative UI inherits the document locale when no locale is supplied. */
export const resolveMarkdownReferenceMessages = (locale?: string): MarkdownReferenceMessages =>
  markdownReferenceMessages.resolve([
    locale ?? (typeof document === "undefined" ? markdownReferenceMessages.baseLocale : document.documentElement.lang),
  ]).t;

export const checkMarkdownReferenceMessages = () => markdownReferenceMessages.check();
