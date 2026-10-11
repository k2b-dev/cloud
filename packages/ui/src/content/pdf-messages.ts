import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const pdfMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      openPreview: "Open preview",
      pdfPreview: "PDF preview",
      pdfPreviewHttpError: ({ status }: { status: number }) => `PDF preview failed with HTTP ${status}`,
      pdfPreviewTabBlocked: "The browser blocked the new tab. Allow pop-ups and try again.",
      pdfPreviewNoViewer: "This PDF cannot be shown here",
      pdfPreviewNoViewerDescription: "Your browser cannot show PDFs inside a page. Open the document to view it.",
      pdfPreviewRendering: "Rendering PDF preview…",
      previewPdf: "Preview PDF",
      renderPdfPreview: "Render a PDF preview to see the final output.",
    },
    de: {
      openPreview: "Vorschau öffnen",
      pdfPreview: "PDF-Vorschau",
      pdfPreviewHttpError: ({ status }) => `PDF-Vorschau ist mit HTTP ${status} fehlgeschlagen`,
      pdfPreviewTabBlocked: "Der Browser hat den neuen Tab blockiert. Erlaube Pop-ups und versuche es erneut.",
      pdfPreviewNoViewer: "Dieses PDF kann hier nicht angezeigt werden",
      pdfPreviewNoViewerDescription: "Dein Browser kann PDFs nicht innerhalb einer Seite anzeigen. Öffne das Dokument, um es anzusehen.",
      pdfPreviewRendering: "PDF-Vorschau wird erstellt…",
      previewPdf: "PDF anzeigen",
      renderPdfPreview: "Erzeuge eine PDF-Vorschau, um das Endergebnis zu sehen.",
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
