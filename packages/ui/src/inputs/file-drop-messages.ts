import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const fileDropMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      fileTypeNotAccepted: "File type not accepted",
      fileDropDropped: ({ count }: { count: number }) => `Dropped ${count} files`,
      fileDropDroppedOne: ({ name }: { name: string }) => `Dropped ${name}`,
      fileDropMore: ({ count }: { count: number }) => `and ${count} more`,
      fileDropRejectedType: ({ names }: { names: string }) => `Not added, this file type is not accepted here: ${names}`,
      fileDropRejectedSize: ({ names, limit }: { names: string; limit: string }) => `Not added, larger than ${limit}: ${names}`,
      fileDropRejectedCount: ({ names, max }: { names: string; max: number }) =>
        max === 1 ? `Only one file at a time. Not added: ${names}` : `Up to ${max} files at a time. Not added: ${names}`,
    },
    de: {
      fileTypeNotAccepted: "Dateityp wird nicht akzeptiert",
      fileDropDropped: ({ count }: { count: number }) => `${count} Dateien abgelegt`,
      fileDropDroppedOne: ({ name }: { name: string }) => `${name} abgelegt`,
      fileDropMore: ({ count }: { count: number }) => `und ${count} weitere`,
      fileDropRejectedType: ({ names }: { names: string }) => `Nicht hinzugefügt, dieser Dateityp wird hier nicht angenommen: ${names}`,
      fileDropRejectedSize: ({ names, limit }: { names: string; limit: string }) => `Nicht hinzugefügt, größer als ${limit}: ${names}`,
      fileDropRejectedCount: ({ names, max }: { names: string; max: number }) =>
        max === 1
          ? `Nur eine Datei auf einmal. Nicht hinzugefügt: ${names}`
          : `Höchstens ${max} Dateien auf einmal. Nicht hinzugefügt: ${names}`,
    },
  },
});

export type FileDropMessages = ReturnType<(typeof fileDropMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useFileDropMessages = (): (() => FileDropMessages) => {
  const locale = useLocale();
  return () => fileDropMessages.resolve([locale()]).t;
};

/** Imperative UI inherits the document locale when no locale is supplied. */
export const resolveFileDropMessages = (locale?: string): FileDropMessages =>
  fileDropMessages.resolve([locale ?? (typeof document === "undefined" ? fileDropMessages.baseLocale : document.documentElement.lang)]).t;

export const checkFileDropMessages = () => fileDropMessages.check();
