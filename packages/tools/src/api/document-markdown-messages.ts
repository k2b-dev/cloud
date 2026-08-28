import { i18n } from "@k2b/stdlib";

/**
 * Human-facing messages for the document-to-Markdown feature. The API and the
 * island share the same wording for shared limits; stable error `code` values
 * are never translated.
 */
export const documentMarkdownMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      extractionFailed: "The document could not be extracted.",
      uploadMultipart: "Upload one document as multipart form data.",
      contentLengthRequired: "A valid Content-Length header is required.",
      documentTooLarge: "The document exceeds the 20 MB limit.",
      conversionBusy: "Document conversion is busy. Try again in a moment.",
      filenameTooLong: "The filename must not exceed 255 characters.",
      signInToConvert: "Sign in to convert documents.",
      tooManyConversions: "Too many conversions. Wait a moment and try again.",
      conversionFailed: "The document could not be converted.",
      unexpectedResult: "The server returned an unexpected result.",
      convertingDocument: "Converting document…",
      dropTitle: "Drop a document or choose a file",
      dropSubtitle: "PDF, Word, PowerPoint, spreadsheets, RTF, EPUB, or CSV",
      dropHint: "Maximum document size: 20 MB",
      dropAriaLabel: "Choose a document to convert to Markdown",
      serverNotice:
        "The document is sent to this Cloud server for conversion. Neither the upload nor the Markdown result is stored by this tool.",
      convertingFile: ({ filename }: { filename: string }) => `Converting ${filename}…`,
      cancel: "Cancel",
      conversionFailedTitle: "Conversion failed",
      previewTitle: "Markdown preview",
      previewDescription: "Choose one supported document to extract its readable text as plain Markdown.",
      conversionComplete: ({ filename }: { filename: string }) => `Conversion complete for ${filename}.`,
      copyMarkdown: "Copy Markdown",
      downloadMd: "Download .md",
      truncatedTitle: "Preview shortened",
      truncatedBody: "The extracted Markdown reached the 1 MB output limit. Download and preview contain the same shortened result.",
      extractedFromAria: ({ filename }: { filename: string }) => `Plain Markdown extracted from ${filename}`,
      resultMeta: ({ format, input, output }: { format: string; input: string; output: string }) =>
        `${format} · ${input} input · ${output} Markdown`,
    },
    de: {
      extractionFailed: "Das Dokument konnte nicht ausgelesen werden.",
      uploadMultipart: "Lade ein Dokument als Multipart-Formulardaten hoch.",
      contentLengthRequired: "Ein gültiger Content-Length-Header ist erforderlich.",
      documentTooLarge: "Das Dokument überschreitet das Limit von 20 MB.",
      conversionBusy: "Der Dokumentkonverter ist ausgelastet. Versuche es gleich erneut.",
      filenameTooLong: "Der Dateiname darf höchstens 255 Zeichen lang sein.",
      signInToConvert: "Melde dich an, um Dokumente zu konvertieren.",
      tooManyConversions: "Derzeit laufen zu viele Konvertierungen. Versuche es gleich erneut.",
      conversionFailed: "Das Dokument konnte nicht konvertiert werden.",
      unexpectedResult: "Der Server hat ein unerwartetes Ergebnis zurückgegeben.",
      convertingDocument: "Dokument wird konvertiert…",
      dropTitle: "Dokument hier ablegen oder Datei auswählen",
      dropSubtitle: "PDF, Word, PowerPoint, Tabellen, RTF, EPUB oder CSV",
      dropHint: "Maximale Dokumentgröße: 20 MB",
      dropAriaLabel: "Dokument für die Konvertierung zu Markdown auswählen",
      serverNotice:
        "Das Dokument wird zur Konvertierung an diesen Cloud-Server gesendet. Das Werkzeug speichert weder den Upload noch das Markdown-Ergebnis.",
      convertingFile: ({ filename }) => `${filename} wird konvertiert…`,
      cancel: "Abbrechen",
      conversionFailedTitle: "Konvertierung fehlgeschlagen",
      previewTitle: "Markdown-Vorschau",
      previewDescription: "Wähle ein unterstütztes Dokument aus. Der lesbare Text wird als reines Markdown extrahiert.",
      conversionComplete: ({ filename }) => `${filename} wurde konvertiert.`,
      copyMarkdown: "Markdown kopieren",
      downloadMd: ".md herunterladen",
      truncatedTitle: "Vorschau gekürzt",
      truncatedBody: "Das extrahierte Markdown hat das Limit von 1 MB erreicht. Vorschau und Download enthalten dieselbe gekürzte Ausgabe.",
      extractedFromAria: ({ filename }) => `Reines Markdown, extrahiert aus ${filename}`,
      resultMeta: ({ format, input, output }) => `${format} · Eingabe: ${input} · Markdown: ${output}`,
    },
  },
});

export type DocumentMarkdownMessages = ReturnType<typeof documentMarkdownMessages.resolve>["t"];
