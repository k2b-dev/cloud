import { i18n } from "@k2b/stdlib";
import type { NotebookBlockDiagnostic } from "./query-blocks";

export const bookRendererMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      toc: "Contents",
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
      toc: "Inhalt",
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
