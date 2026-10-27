import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** File kinds and list folding shared by `FileGrid` and `fileKindLabel`. */
const fileListMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      folder: "Folder",
      pdf: "PDF",
      image: "Image",
      sheet: "Spreadsheet",
      document: "Document",
      slides: "Presentation",
      video: "Video",
      audio: "Audio",
      archive: "Archive",
      file: "File",
      files: "Files",
      images: "Images",
      showAll: ({ count }: { count: number }) => `Show all ${count}`,
      showLess: "Show less",
    },
    de: {
      folder: "Ordner",
      pdf: "PDF",
      image: "Bild",
      sheet: "Tabelle",
      document: "Dokument",
      slides: "Präsentation",
      video: "Video",
      audio: "Audio",
      archive: "Archiv",
      file: "Datei",
      files: "Dateien",
      images: "Bilder",
      showAll: ({ count }) => `Alle ${count} anzeigen`,
      showLess: "Weniger anzeigen",
    },
  },
});

export type FileListMessages = ReturnType<(typeof fileListMessages)["resolve"]>["t"];

export const resolveFileListMessages = (locale: string): FileListMessages => fileListMessages.resolve([locale]).t;

export const useFileListMessages = (): (() => FileListMessages) => {
  const locale = useLocale();
  return () => resolveFileListMessages(locale());
};

export const checkFileListMessages = () => fileListMessages.check();
