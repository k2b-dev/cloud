import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const chartMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      chartView: "Chart view",
      chartDiagram: "Diagram",
      chartData: "Table",
      chartSeries: "Series visibility",
      chartOnly: "Only",
      chartShowAll: "Show all",
      chartShowing: "Showing",
      chartSelectedDatum: "Selected data point",
      chartReference: "Reference",
      chartCurrent: "Current",
      chartPinReference: "Pin as reference",
      chartRemoveComparison: "Remove comparison",
      chartPreviousData: "The chart and table still show the last loaded filters",
      chartCopyData: "Copy data",
      chartCopyFailed: "Could not copy data",
      chartLegend: "Legend",
      interactiveLineChart: "Interactive line chart",
      interactiveChart:
        "Interactive chart. Use arrow keys to inspect, Enter to select, Escape to dismiss. On maps and timelines use Alt with arrow keys to inspect.",
      chartFields: ({ key }: { key: string }) => {
        const labels: Record<string, string> = {
          x: "X",
          y: "Y",
          value: "Value",
          percent: "Share",
          total: "Total",
          from: "From",
          to: "To",
          upperInclusive: "Includes upper bound",
          count: "Count",
          q1: "Lower quartile",
          q2: "Median",
          q3: "Upper quartile",
          whiskerLow: "Lower whisker",
          whiskerHigh: "Upper whisker",
          min: "Minimum",
          max: "Maximum",
          threshold: "Threshold",
          delta: "Change",
          latitude: "Latitude",
          longitude: "Longitude",
          size: "Size",
          state: "State",
          duration: "Duration",
          detail: "Detail",
          errY: "Y error",
          errYHigh: "Upper Y error",
          errYLow: "Lower Y error",
          errX: "X error",
          errXHigh: "Upper X error",
          errXLow: "Lower X error",
        };
        return labels[key] ?? key;
      },
      interactiveMap: "Interactive map",
      interactiveTimeline: "Interactive timeline",
      series: "Series",
      resetMapView: "Reset map view",
      resetTimelineView: "Reset timeline view",
    },
    de: {
      chartView: "Diagrammansicht",
      chartDiagram: "Diagramm",
      chartData: "Tabelle",
      chartSeries: "Sichtbare Datenreihen",
      chartOnly: "Nur diese",
      chartShowAll: "Alle anzeigen",
      chartShowing: "Angezeigt",
      chartSelectedDatum: "Ausgewählter Datenpunkt",
      chartReference: "Vergleich",
      chartCurrent: "Aktuell",
      chartPinReference: "Als Vergleich merken",
      chartRemoveComparison: "Vergleich entfernen",
      chartPreviousData: "Diagramm und Tabelle zeigen weiterhin die zuletzt geladenen Filter",
      chartCopyData: "Daten kopieren",
      chartCopyFailed: "Daten konnten nicht kopiert werden",
      chartLegend: "Legende",
      interactiveLineChart: "Interaktives Liniendiagramm",
      interactiveChart:
        "Interaktives Diagramm. Pfeiltasten zum Erkunden, Enter zum Auswählen, Escape zum Schließen. In Karten und Zeitleisten Alt mit Pfeiltasten zum Erkunden.",
      chartFields: ({ key }: { key: string }) => {
        const labels: Record<string, string> = {
          x: "X",
          y: "Y",
          value: "Wert",
          percent: "Anteil",
          total: "Gesamt",
          from: "Von",
          to: "Bis",
          upperInclusive: "Obergrenze enthalten",
          count: "Anzahl",
          q1: "Unteres Quartil",
          q2: "Median",
          q3: "Oberes Quartil",
          whiskerLow: "Unterer Whisker",
          whiskerHigh: "Oberer Whisker",
          min: "Minimum",
          max: "Maximum",
          threshold: "Schwellenwert",
          delta: "Änderung",
          latitude: "Breitengrad",
          longitude: "Längengrad",
          size: "Größe",
          state: "Zustand",
          duration: "Dauer",
          detail: "Details",
          errY: "Y-Fehler",
          errYHigh: "Oberer Y-Fehler",
          errYLow: "Unterer Y-Fehler",
          errX: "X-Fehler",
          errXHigh: "Oberer X-Fehler",
          errXLow: "Unterer X-Fehler",
        };
        return labels[key] ?? key;
      },
      interactiveMap: "Interaktive Karte",
      interactiveTimeline: "Interaktive Zeitachse",
      series: "Datenreihe",
      resetMapView: "Kartenansicht zurücksetzen",
      resetTimelineView: "Zeitachsenansicht zurücksetzen",
    },
  },
});

export type ChartMessages = ReturnType<(typeof chartMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useChartMessages = (): (() => ChartMessages) => {
  const locale = useLocale();
  return () => chartMessages.resolve([locale()]).t;
};

export const checkChartMessages = () => chartMessages.check();
