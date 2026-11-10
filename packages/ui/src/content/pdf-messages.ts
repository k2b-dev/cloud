import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const pdfMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      pdfOpenInTab: "Open in new tab",
      pdfPreview: "PDF preview",
      pdfPreviewHttpError: ({ status }: { status: number }) => `PDF preview failed with HTTP ${status}`,
      pdfPreviewTabBlocked: "The browser blocked the new tab. Allow pop-ups and try again.",
      pdfPreviewNoViewer: "This PDF cannot be shown here",
      pdfPreviewNoViewerDescription: "Open it in a new tab or download it to view it.",
      pdfPreviewRendering: "Rendering PDF preview…",
      previewPdf: "Preview PDF",
      renderPdfPreview: "Render a PDF preview to see the final output.",
      pdfPage: ({ number, total }: { number: number; total: number }) => `Page ${number} of ${total}`,
      pdfPageShort: ({ number, total }: { number: number; total: number }) => `${number} / ${total}`,
      pdfZoom: "Zoom",
      pdfZoomOut: "Zoom out",
      pdfZoomIn: "Zoom in",
      pdfZoomPercent: ({ value }: { value: number }) => `${value}%`,
      pdfFitWidthLabel: "Fit to width",
      pdfFitPageLabel: "Show the whole page",
    },
    de: {
      pdfOpenInTab: "In neuem Tab öffnen",
      pdfPreview: "PDF-Vorschau",
      pdfPreviewHttpError: ({ status }) => `PDF-Vorschau ist mit HTTP ${status} fehlgeschlagen`,
      pdfPreviewTabBlocked: "Der Browser hat den neuen Tab blockiert. Erlaube Pop-ups und versuche es erneut.",
      pdfPreviewNoViewer: "Dieses PDF kann hier nicht angezeigt werden",
      pdfPreviewNoViewerDescription: "Öffne es in einem neuen Tab oder lade es herunter, um es anzusehen.",
      pdfPreviewRendering: "PDF-Vorschau wird erstellt…",
      previewPdf: "PDF anzeigen",
      renderPdfPreview: "Erzeuge eine PDF-Vorschau, um das Endergebnis zu sehen.",
      pdfPage: ({ number, total }) => `Seite ${number} von ${total}`,
      pdfPageShort: ({ number, total }) => `${number} / ${total}`,
      pdfZoom: "Zoom",
      pdfZoomOut: "Verkleinern",
      pdfZoomIn: "Vergrößern",
      pdfZoomPercent: ({ value }) => `${value} %`,
      pdfFitWidthLabel: "An die Breite anpassen",
      pdfFitPageLabel: "Ganze Seite zeigen",
    },
  },
});

export type PdfMessages = ReturnType<(typeof pdfMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const usePdfMessages = (): (() => PdfMessages) => {
  const locale = useLocale();
  return () => pdfMessages.resolve([locale()]).t;
};

/** Imperative UI inherits the document locale when no locale is supplied. */
export const resolvePdfMessages = (locale?: string): PdfMessages =>
  pdfMessages.resolve([locale ?? (typeof document === "undefined" ? pdfMessages.baseLocale : document.documentElement.lang)]).t;

export const checkPdfMessages = () => pdfMessages.check();
