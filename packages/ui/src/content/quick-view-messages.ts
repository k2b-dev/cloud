import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const quickViewMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      quickView: ({ name }: { name: string }) => `Quick view: ${name}`,
      close: "Close",
      closeHint: "Close (Esc)",
      previous: "Previous file",
      next: "Next file",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      zoom: "Zoom and pages",
      position: ({ index, total }: { index: number; total: number }) => `${index} of ${total}`,
      percent: ({ value }: { value: number }) => `${value} %`,
      items: "Files",
    },
    de: {
      quickView: ({ name }) => `Schnellansicht: ${name}`,
      close: "Schließen",
      closeHint: "Schließen (Esc)",
      previous: "Vorherige Datei",
      next: "Nächste Datei",
      zoomIn: "Größer",
      zoomOut: "Kleiner",
      zoom: "Blättern und Zoom",
      position: ({ index, total }) => `${index} von ${total}`,
      percent: ({ value }) => `${value} %`,
      items: "Dateien",
    },
  },
});

export type QuickViewMessages = ReturnType<(typeof quickViewMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useQuickViewMessages = (): (() => QuickViewMessages) => {
  const locale = useLocale();
  return () => quickViewMessages.resolve([locale()]).t;
};

export const checkQuickViewMessages = () => quickViewMessages.check();
