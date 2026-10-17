import { i18n } from "@k2b/stdlib";
import type { NotePdfOmission } from "./pdf-omissions";
import type { NotebookBlockDiagnostic } from "./query-blocks";

export const bookRendererMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      omissionKind_image: "Image",
      omissionKind_diagram: "Diagram",
      omissionKind_query: "Query",
      omissionKind_toc: "Contents",
      omissionKind_data: "Data",
      omissionKind_chart: "Chart",
      omissionKind_callout: "Callout",
      omissionKind_math: "Formula",
      omissionKind_formula: "Table formula",
      omissionReason_not_found: "The file was not found.",
      omissionReason_unsupported_format: "This format cannot be printed.",
      omissionReason_unreadable: "The file could not be read.",
      omissionReason_too_large: "The file is too large.",
      omissionReason_over_budget: "The PDF has no room left for it.",
      omissionReason_unreachable: "The address could not be reached.",
      omissionReason_blocked: "The address is not allowed.",
      omissionReason_timed_out: "It took too long to prepare.",
      omissionReason_not_rendered: "It is not printed in the PDF yet.",
      omissionReason_invalid_block: "It contains an error.",
      omissionHint_not_found: "Attach the file again.",
      omissionHint_unsupported_format: "Use JPEG, PNG, WebP, GIF or SVG.",
      omissionHint_unreadable: "Check the file, then attach it again.",
      omissionHint_too_large: "Use a smaller file or split the note.",
      omissionHint_over_budget: "Use a smaller file or split the note.",
      omissionHint_unreachable: "Try again later.",
      omissionHint_blocked: "Use an attachment instead.",
      omissionHint_timed_out: "Try again later.",
      omissionHint_not_rendered: "Open the note to see it.",
      omissionHint_invalid_block: "Fix it in the note where the PDF marks it, then download again.",
      omissionQueryReason: "Its result is not available.",
      omissionQueryHint: "Open the note in Book to check the query, then download again.",
      omissionImageHint: "The PDF shows its description. Open the note to see the image.",
      omissionDiagramHint: "The PDF shows the diagram source. Open the note to see the diagram.",
      toc: "Contents",
      lineLabel: ({ line }: { line: number }) => `Line ${line}`,
      chartLegend: "Legend",
      emptyToc: "No headings in this section.",
      emptyQuery: "No matching notes.",
      unavailableQuery: "This query is unavailable.",
      invalidBlock: ({ line }: { line: number }) => `Invalid block at line ${line}.`,
      "duplicate-key": "Duplicate key.",
      "invalid-field": "Unsupported field.",
      "invalid-type": "Invalid value type.",
      "missing-key": "Required key is missing.",
      "missing-value": "A value is required.",
      "too-many-items": ({ limit }: { limit?: number }) =>
        limit === undefined ? "The block limit was exceeded." : `The limit is ${limit} items.`,
      "unknown-block": ({ name }: { name?: string }) => `No table, list or data block named @${name} in this note.`,
      "invalid-source": ({ name }: { name?: string }) => `The block @${name} has errors. Fix it first.`,
      "duplicate-block": ({ name }: { name?: string }) => `More than one block is named @${name}. Rename all but one.`,
      "unknown-column": ({ name }: { name?: string }) => `Unknown column ${name}.`,
      "not-a-number": ({ name, row }: { name?: string; row?: number }) => `Column ${name}, row ${row} must contain a number.`,
      "chart-x-type": "Use numbers or ISO dates for x, or use type: bar for text labels.",
      "chart-one-series": "A bar chart shows one y column. Use one column per bar chart.",
      "chart-unsupported": "These values cannot be drawn as this chart.",
      "unexpected-line": "Unexpected line.",
      "unknown-key": "Unknown key.",
      "unclosed-block": "Close the block with :::.",
      queryCount: ({ shown, total }: { shown: number; total: number }) => `Showing ${shown} of ${total} notes.`,
      title: "Title",
      created: "Created",
      updated: "Last updated",
      tags: "Tags",
      emptyData: "No data.",
      diagramSource: "Diagram source",
      image: ({ alt }: { alt: string }) => (alt ? `Image: ${alt}` : "Image"),
    },
    de: {
      omissionKind_image: "Bild",
      omissionKind_diagram: "Diagramm",
      omissionKind_query: "Abfrage",
      omissionKind_toc: "Inhaltsverzeichnis",
      omissionKind_data: "Daten",
      omissionKind_chart: "Datendiagramm",
      omissionKind_callout: "Hinweis",
      omissionKind_math: "Formel",
      omissionKind_formula: "Tabellenformel",
      omissionReason_not_found: "Die Datei wurde nicht gefunden.",
      omissionReason_unsupported_format: "Dieses Format kann nicht gedruckt werden.",
      omissionReason_unreadable: "Die Datei konnte nicht gelesen werden.",
      omissionReason_too_large: "Die Datei ist zu groß.",
      omissionReason_over_budget: "Im PDF ist dafür kein Platz mehr.",
      omissionReason_unreachable: "Die Adresse konnte nicht erreicht werden.",
      omissionReason_blocked: "Die Adresse ist nicht erlaubt.",
      omissionReason_timed_out: "Die Vorbereitung dauert zu lange.",
      omissionReason_not_rendered: "Es wird noch nicht im PDF gedruckt.",
      omissionReason_invalid_block: "Es enthält einen Fehler.",
      omissionHint_not_found: "Hänge die Datei erneut an.",
      omissionHint_unsupported_format: "Verwende JPEG, PNG, WebP, GIF oder SVG.",
      omissionHint_unreadable: "Prüfe die Datei und hänge sie erneut an.",
      omissionHint_too_large: "Verwende eine kleinere Datei oder teile die Notiz auf.",
      omissionHint_over_budget: "Verwende eine kleinere Datei oder teile die Notiz auf.",
      omissionHint_unreachable: "Versuche es später erneut.",
      omissionHint_blocked: "Verwende stattdessen einen Anhang.",
      omissionHint_timed_out: "Versuche es später erneut.",
      omissionHint_not_rendered: "Öffne die Notiz, um es anzusehen.",
      omissionHint_invalid_block: "Behebe den Fehler in der Notiz an der im PDF markierten Stelle und lade das PDF erneut herunter.",
      omissionQueryReason: "Ihr Ergebnis ist nicht verfügbar.",
      omissionQueryHint: "Öffne die Notiz in der Buchansicht, prüfe die Abfrage und lade das PDF erneut herunter.",
      omissionImageHint: "Das PDF zeigt die Beschreibung. Öffne die Notiz, um das Bild anzusehen.",
      omissionDiagramHint: "Das PDF zeigt den Quelltext. Öffne die Notiz, um das Diagramm anzusehen.",
      toc: "Inhalt",
      lineLabel: ({ line }) => `Zeile ${line}`,
      chartLegend: "Legende",
      emptyToc: "Keine Überschriften in diesem Abschnitt.",
      emptyQuery: "Keine passenden Notizen.",
      unavailableQuery: "Diese Abfrage ist nicht verfügbar.",
      invalidBlock: ({ line }) => `Ungültiger Block in Zeile ${line}.`,
      "duplicate-key": "Doppelter Schlüssel.",
      "invalid-field": "Nicht unterstütztes Feld.",
      "invalid-type": "Ungültiger Werttyp.",
      "missing-key": "Ein erforderlicher Schlüssel fehlt.",
      "missing-value": "Ein Wert ist erforderlich.",
      "too-many-items": ({ limit }) =>
        limit === undefined ? "Das Block-Limit wurde überschritten." : `Die Grenze liegt bei ${limit} Einträgen.`,
      "unknown-block": ({ name }) => `Diese Notiz enthält keine Tabelle, Liste oder Daten mit dem Namen @${name}.`,
      "invalid-source": ({ name }) => `Der Block @${name} enthält Fehler. Behebe sie zuerst.`,
      "duplicate-block": ({ name }) => `Mehrere Blöcke heißen @${name}. Benenne alle bis auf einen um.`,
      "unknown-column": ({ name }) => `Unbekannte Spalte ${name}.`,
      "not-a-number": ({ name, row }) => `Spalte ${name}, Zeile ${row} muss eine Zahl enthalten.`,
      "chart-x-type": "Verwende Zahlen oder ISO-Daten für x oder type: bar für Textbeschriftungen.",
      "chart-one-series": "Ein Balkendiagramm zeigt eine y-Spalte. Verwende eine Spalte pro Balkendiagramm.",
      "chart-unsupported": "Diese Werte können nicht als dieses Diagramm dargestellt werden.",
      "unexpected-line": "Unerwartete Zeile.",
      "unknown-key": "Unbekannter Schlüssel.",
      "unclosed-block": "Den Block mit ::: schließen.",
      queryCount: ({ shown, total }) => `${shown} von ${total} Notizen werden angezeigt.`,
      title: "Titel",
      created: "Erstellt",
      updated: "Zuletzt geändert",
      tags: "Tags",
      emptyData: "Keine Daten.",
      diagramSource: "Diagramm-Quelltext",
      image: ({ alt }) => (alt ? `Bild: ${alt}` : "Bild"),
    },
  },
});

/** One message path for rendered source and every preview consumer. */
export const notebookBlockDiagnosticMessage = (diagnostic: NotebookBlockDiagnostic, locale: string): string => {
  const message = bookRendererMessages.resolve([locale]).t[diagnostic.code];
  return typeof message === "function" ? message(diagnostic.params ?? {}) : message;
};

/** Localized explanation and recovery for the PDF report, shared with the download dialog. */
export const notePdfOmissionText = (omission: NotePdfOmission, locale: string): { kind: string; reason: string; hint: string } => {
  const { t } = bookRendererMessages.resolve([locale]);
  const hint =
    omission.code === "not_rendered"
      ? omission.kind === "query"
        ? t.omissionQueryHint
        : omission.kind === "image"
          ? t.omissionImageHint
          : omission.kind === "diagram"
            ? t.omissionDiagramHint
            : t[`omissionHint_${omission.code}`]
      : t[`omissionHint_${omission.code}`];
  const reason =
    omission.code === "not_rendered" && omission.kind === "query" ? t.omissionQueryReason : t[`omissionReason_${omission.code}`];
  return { kind: t[`omissionKind_${omission.kind}`], reason, hint };
};
