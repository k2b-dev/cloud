import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const fileInputMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      addImage: "Add image",
      dropFiles: "Drop files or click to choose",
      dropToUpload: "Drop to upload",
      uploading: "Uploading…",
      chooseFile: "Choose file",
      chooseFiles: "Choose files",
      chooseMatchingFile: "Choose a file that matches this field.",
      changeImage: "Change image",
      cropArea: "Crop area. Use arrow keys to move; hold Shift for larger steps.",
      cropPreview: "Crop preview",
      failedLoadFiles: "Failed to load files",
      failedLoadImage: "Failed to load image.",
      imageProcessingFailed: "Image could not be processed.",
      preparingImage: "Preparing image…",
      processingImage: "Processing image",
      removeImage: "Remove image",
      rotateRight: "Rotate right",
      selectedImage: "Selected image",
      resizeCrop: ({ handle }: { handle: string }) => `Resize crop ${handle}`,
    },
    de: {
      addImage: "Bild hinzufügen",
      dropFiles: "Dateien ablegen oder zum Auswählen klicken",
      dropToUpload: "Zum Hochladen ablegen",
      uploading: "Wird hochgeladen…",
      chooseFile: "Datei auswählen",
      chooseFiles: "Dateien auswählen",
      chooseMatchingFile: "Wähle eine zu diesem Feld passende Datei aus.",
      changeImage: "Bild ändern",
      cropArea: "Zuschneidebereich. Mit Pfeiltasten verschieben; Umschalt für größere Schritte halten.",
      cropPreview: "Zuschneidevorschau",
      failedLoadFiles: "Dateien konnten nicht geladen werden",
      failedLoadImage: "Bild konnte nicht geladen werden.",
      imageProcessingFailed: "Bild konnte nicht verarbeitet werden.",
      preparingImage: "Bild wird vorbereitet…",
      processingImage: "Bild wird verarbeitet",
      removeImage: "Bild entfernen",
      rotateRight: "Nach rechts drehen",
      selectedImage: "Ausgewähltes Bild",
      resizeCrop: ({ handle }) => `Zuschneidebereich am Griff ${handle} skalieren`,
    },
  },
});

export type FileInputMessages = ReturnType<(typeof fileInputMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useFileInputMessages = (): (() => FileInputMessages) => {
  const locale = useLocale();
  return () => fileInputMessages.resolve([locale()]).t;
};

export const checkFileInputMessages = () => fileInputMessages.check();
