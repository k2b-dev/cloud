import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const fileViewMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      column: ({ number }: { number: number }) => `Column ${number}`,
      fileSaved: "File saved",
      noPreview: "No preview",
      binaryFile: "Binary file",
      csvSettings: "CSV preview settings",
      csvEncoding: "Encoding",
      csvSeparator: "Separator",
      csvDefaultSeparator: "File type default",
      csvComma: "Comma",
      csvSemicolon: "Semicolon",
      csvTab: "Tab",
      csvView: "Display",
      csvRaw: "Raw text",
      delimitedFileEmpty: "This delimited file contains no rows.",
      emptyFile: "Empty file",
      failedLoadFile: "Failed to load file",
      noInlinePreview: "No inline preview available for this source.",
      previewMoreLines: (n: number) => `… ${n} more lines`,
      previewColumnsLimited: "Showing the first 50 columns. Download the file for all columns.",
      textEditor: "Text editor",
      audioUnsupported: "Your browser does not support audio playback.",
    },
    de: {
      column: ({ number }) => `Spalte ${number}`,
      fileSaved: "Datei gespeichert",
      noPreview: "Keine Vorschau",
      binaryFile: "Binärdatei",
      csvSettings: "CSV-Vorschau einstellen",
      csvEncoding: "Zeichenkodierung",
      csvSeparator: "Trennzeichen",
      csvDefaultSeparator: "Standard des Dateityps",
      csvComma: "Komma",
      csvSemicolon: "Semikolon",
      csvTab: "Tabulator",
      csvView: "Darstellung",
      csvRaw: "Rohtext",
      delimitedFileEmpty: "Diese Trennzeichen-Datei enthält keine Zeilen.",
      emptyFile: "Leere Datei",
      failedLoadFile: "Datei konnte nicht geladen werden",
      noInlinePreview: "Für diese Quelle ist keine direkte Vorschau verfügbar.",
      previewMoreLines: (n: number) => `… ${n} weitere Zeilen`,
      previewColumnsLimited: "Die ersten 50 Spalten werden angezeigt. Lade die Datei für alle Spalten herunter.",
      textEditor: "Texteditor",
      audioUnsupported: "Dein Browser unterstützt keine Audiowiedergabe.",
    },
  },
});

export type FileViewMessages = ReturnType<(typeof fileViewMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useFileViewMessages = (): (() => FileViewMessages) => {
  const locale = useLocale();
  return () => fileViewMessages.resolve([locale()]).t;
};

export const checkFileViewMessages = () => fileViewMessages.check();
