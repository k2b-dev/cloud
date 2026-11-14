import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const lightboxMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      actions: "Actions",
      close: "Close",
      closeHint: "Close (Esc)",
      download: "Download",
      open: "Open",
      previous: "Previous file",
      next: "Next file",
      files: "Files",
      view: "View",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      percent: ({ value }: { value: number }): string => `${value} %`,
      page: ({ number, total }: { number: number; total: number }): string => `Page ${number} / ${total}`,
      sheet: ({ number, total }: { number: number; total: number }): string => `Sheet ${number} / ${total}`,
      loading: "Preview loads",
      converting: "Converting for the preview …",
      failed: "The preview could not be loaded",
      failedHint: "You can still download the file.",
      retry: "Try again",
      notPossible: "Preview not possible",
      notPossibleHint: "The file could not be converted for the preview.",
      noPreview: "There is no preview for this file",
      noPreviewHint: "Download it and open it with a suitable program.",
      viewOnly: "view only",
    },
    de: {
      actions: "Aktionen",
      close: "Schließen",
      closeHint: "Schließen (Esc)",
      download: "Herunterladen",
      open: "Öffnen",
      previous: "Vorherige Datei",
      next: "Nächste Datei",
      files: "Dateien",
      view: "Ansicht",
      zoomIn: "Vergrößern",
      zoomOut: "Verkleinern",
      percent: ({ value }) => `${value} %`,
      page: ({ number, total }) => `Seite ${number} / ${total}`,
      sheet: ({ number, total }) => `Blatt ${number} / ${total}`,
      loading: "Vorschau lädt",
      converting: "Wird für die Vorschau umgewandelt …",
      failed: "Die Vorschau konnte nicht geladen werden",
      failedHint: "Herunterladen geht trotzdem.",
      retry: "Erneut versuchen",
      notPossible: "Vorschau nicht möglich",
      notPossibleHint: "Die Datei ließ sich nicht für die Vorschau umwandeln.",
      noPreview: "Für diese Datei gibt es keine Vorschau",
      noPreviewHint: "Herunterladen und mit einem passenden Programm öffnen.",
      viewOnly: "nur Ansicht",
    },
  },
});

export type LightboxMessages = ReturnType<(typeof lightboxMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useLightboxMessages = (): (() => LightboxMessages) => {
  const locale = useLocale();
  return () => lightboxMessages.resolve([locale()]).t;
};

export const checkLightboxMessages = () => lightboxMessages.check();
