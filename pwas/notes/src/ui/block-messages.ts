import type { BlockPreviewMessages } from "@k2b/editor/markdown";
import type { NotebookBlockDiagnostic } from "@k2b/editor/markdown/lib/query-blocks";
import { i18n } from "@k2b/stdlib";

/** Texts of rendered blocks such as charts, and of the hints the editor shows on a block line that cannot be drawn. */
export const blockMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      loading: "Drawing the chart…",
      failed: "The chart could not be drawn.",
      savedChanged: "The note changed. Reload to update the chart.",
      reload: "Reload",
      headingUnavailable: "This heading is not in the note.",
      showSource: "Show source",
      retry: "Try again",
      chart: "Chart",
      map: "Map",
      query: "Note query",
      toc: "Table of contents",
      "duplicate-key": "Duplicate key.",
      "invalid-field": "Unsupported field.",
      "invalid-type": "Invalid value type.",
      "missing-key": "Required key is missing.",
      "missing-value": "A value is required.",
      "too-many-items": ({ limit }: { limit?: number }) =>
        limit === undefined ? "The block limit was exceeded." : `The limit is ${limit} items.`,
      "unexpected-line": "Unexpected line.",
      "unknown-key": "Unknown key.",
      "unclosed-block": "Close the block with :::.",
      "unknown-block": ({ name }: { name?: string }) => `No table, list or data block named @${name} in this note.`,
      "invalid-source": ({ name }: { name?: string }) => `The block @${name} has errors. Fix it first.`,
      "duplicate-block": ({ name }: { name?: string }) => `More than one block is named @${name}. Rename all but one.`,
      "unknown-column": ({ name }: { name?: string }) => `Unknown column ${name}.`,
      "not-a-number": ({ name, row }: { name?: string; row?: number }) => `Column ${name}, row ${row} must contain a number.`,
      "chart-x-type": "Use numbers or ISO dates for x, or use type: bar for text labels.",
      "chart-one-series": "A bar chart shows one y column. Use one column per bar chart.",
      "chart-unsupported": "These values cannot be drawn as this chart.",
    },
    de: {
      loading: "Diagramm wird gezeichnet …",
      failed: "Das Diagramm konnte nicht gezeichnet werden.",
      savedChanged: "Die Notiz hat sich geändert. Lade neu, um das Diagramm zu aktualisieren.",
      reload: "Neu laden",
      headingUnavailable: "Diese Überschrift steht nicht in der Notiz.",
      showSource: "Quelltext anzeigen",
      retry: "Erneut versuchen",
      chart: "Diagramm",
      map: "Karte",
      query: "Notizabfrage",
      toc: "Inhaltsverzeichnis",
      "duplicate-key": "Doppelter Schlüssel.",
      "invalid-field": "Nicht unterstütztes Feld.",
      "invalid-type": "Ungültiger Werttyp.",
      "missing-key": "Ein erforderlicher Schlüssel fehlt.",
      "missing-value": "Ein Wert ist erforderlich.",
      "too-many-items": ({ limit }) =>
        limit === undefined ? "Das Block-Limit wurde überschritten." : `Die Grenze liegt bei ${limit} Einträgen.`,
      "unexpected-line": "Unerwartete Zeile.",
      "unknown-key": "Unbekannter Schlüssel.",
      "unclosed-block": "Den Block mit ::: schließen.",
      "unknown-block": ({ name }) => `Diese Notiz enthält keine Tabelle, Liste oder Daten mit dem Namen @${name}.`,
      "invalid-source": ({ name }) => `Der Block @${name} enthält Fehler. Behebe sie zuerst.`,
      "duplicate-block": ({ name }) => `Mehrere Blöcke heißen @${name}. Benenne alle bis auf einen um.`,
      "unknown-column": ({ name }) => `Unbekannte Spalte ${name}.`,
      "not-a-number": ({ name, row }) => `Spalte ${name}, Zeile ${row} muss eine Zahl enthalten.`,
      "chart-x-type": "Verwende Zahlen oder ISO-Daten für x oder type: bar für Textbeschriftungen.",
      "chart-one-series": "Ein Balkendiagramm zeigt eine y-Spalte. Verwende eine Spalte pro Balkendiagramm.",
      "chart-unsupported": "Diese Werte können nicht als dieses Diagramm dargestellt werden.",
    },
  },
});

export const blockPreviewMessages = (locale: string): BlockPreviewMessages => {
  const { t } = blockMessages.resolve([locale]);
  return {
    loading: t.loading,
    failed: t.failed,
    savedChanged: t.savedChanged,
    reload: t.reload,
    headingUnavailable: t.headingUnavailable,
    showSource: t.showSource,
    retry: t.retry,
    chart: t.chart,
    map: t.map,
    query: t.query,
    toc: t.toc,
  };
};

export const blockDiagnostic = (locale: string, diagnostic: NotebookBlockDiagnostic): string => {
  const { t } = blockMessages.resolve([locale]);
  const params = diagnostic.params ?? {};
  switch (diagnostic.code) {
    case "too-many-items":
      return t["too-many-items"](params);
    case "unknown-block":
    case "invalid-source":
    case "duplicate-block":
    case "unknown-column":
      return t[diagnostic.code](params);
    case "not-a-number":
      return t["not-a-number"](params);
    default:
      return t[diagnostic.code];
  }
};
