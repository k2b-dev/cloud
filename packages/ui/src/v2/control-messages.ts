import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** The words of the v2 form controls (tags, image, colour), resolved from the inherited render locale. */
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
    },
  },
});

export type ControlMessages = ReturnType<(typeof controlMessages)["resolve"]>["t"];

export const useControlMessages = (): (() => ControlMessages) => {
  const locale = useLocale();
  return () => controlMessages.resolve([locale()]).t;
};

export const checkControlMessages = () => controlMessages.check();
