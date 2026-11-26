import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** The words of the v2 form controls (tags, image, files, colour), resolved from the inherited render locale. */
const controlMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      removeValue: ({ label }: { label: string }) => `Remove ${label}`,
      chooseImage: "Choose image",
      changeImage: "Change image",
      removeImage: "Remove image",
      noImage: "No image",
      imageFailed: "The image could not be read. Choose another one.",
      colorArea: "Saturation and brightness",
      hue: "Hue",
      colorCode: "Colour code",
      color: ({ value }: { value: string }) => `Colour ${value}`,
      hueValue: ({ degrees }: { degrees: number }) => `${degrees} degrees`,
      areaValue: ({ saturation, brightness }: { saturation: number; brightness: number }) =>
        `Saturation ${saturation} %, brightness ${brightness} %`,
      imageChosen: "Image chosen",
      dropFile: "Drop a file here or",
      dropFiles: "Drop files here or",
      chooseFile: "choose a file",
      chooseFiles: "choose files",
      filesChosen: ({ count }: { count: number }) => (count === 1 ? "1 file chosen" : `${count} files chosen`),
      fileRemoved: ({ name }: { name: string }) => `${name} removed`,
      fileType: ({ name }: { name: string }) => `${name} is not a type this field takes.`,
      fileTooLarge: ({ name, max }: { name: string; max: string }) => `${name} is larger than ${max}.`,
      tooManyFiles: "This field takes one file only.",
      folder: "This field takes files, not folders. Choose the files in it.",
      filesRemoved: ({ count }: { count: number }) => `${count} files removed`,
    },
    de: {
      removeValue: ({ label }: { label: string }) => `${label} entfernen`,
      chooseImage: "Bild wählen",
      changeImage: "Bild ändern",
      removeImage: "Bild entfernen",
      noImage: "Kein Bild",
      imageFailed: "Das Bild ließ sich nicht lesen. Wähle ein anderes.",
      colorArea: "Sättigung und Helligkeit",
      hue: "Farbton",
      colorCode: "Farbcode",
      color: ({ value }: { value: string }) => `Farbe ${value}`,
      hueValue: ({ degrees }: { degrees: number }) => `${degrees} Grad`,
      areaValue: ({ saturation, brightness }: { saturation: number; brightness: number }) =>
        `Sättigung ${saturation} %, Helligkeit ${brightness} %`,
      imageChosen: "Bild gewählt",
      dropFile: "Datei hierher ziehen oder",
      dropFiles: "Dateien hierher ziehen oder",
      chooseFile: "Datei wählen",
      chooseFiles: "Dateien wählen",
      filesChosen: ({ count }: { count: number }) => (count === 1 ? "1 Datei gewählt" : `${count} Dateien gewählt`),
      fileRemoved: ({ name }: { name: string }) => `${name} entfernt`,
      fileType: ({ name }: { name: string }) => `${name} hat keinen Dateityp, den dieses Feld nimmt.`,
      fileTooLarge: ({ name, max }: { name: string; max: string }) => `${name} ist größer als ${max}.`,
      tooManyFiles: "Dieses Feld nimmt nur eine Datei.",
      folder: "Dieses Feld nimmt Dateien, keine Ordner. Wähle die Dateien darin.",
      filesRemoved: ({ count }: { count: number }) => `${count} Dateien entfernt`,
    },
  },
});

export type ControlMessages = ReturnType<(typeof controlMessages)["resolve"]>["t"];

export const useControlMessages = (): (() => ControlMessages) => {
  const locale = useLocale();
  return () => controlMessages.resolve([locale()]).t;
};

export const checkControlMessages = () => controlMessages.check();
