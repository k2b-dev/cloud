import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** The words of the v2 form controls (tags, image, colour), resolved from the inherited render locale. */
const controlMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      removeValue: ({ label }: { label: string }) => `Remove ${label}`,
      chooseOne: "Choose at least one option.",
      notAnAddress: ({ text }: { text: string }) => `“${text}” is not an e-mail address.`,
      tooManyAddresses: ({ max, left }: { max: number; left: number }) =>
        `This field takes ${max} addresses at most; ${left === 1 ? "1 was" : `${left} were`} not added.`,
      tooManyValues: ({ max, left }: { max: number; left: number }) =>
        `This field takes ${max} values at most; ${left === 1 ? "1 was" : `${left} were`} not added.`,
      addressesAdded: ({ count }: { count: number }) => (count === 1 ? "1 address added." : `${count} addresses added.`),
      addressesRemoved: ({ count }: { count: number }) => (count === 1 ? "1 address removed." : `${count} addresses removed.`),
      chooseImage: "Choose image",
      changeImage: "Change image",
      removeImage: "Remove image",
      noImage: "No image",
      imageFailed: "The image could not be read. Choose another one.",
      pickColor: "Pick a colour",
      colorArea: "Saturation and brightness",
      hue: "Hue",
      colorCode: "Colour code",
      color: ({ value }: { value: string }) => `Colour ${value}`,
      hueValue: ({ degrees }: { degrees: number }) => `${degrees} degrees`,
      areaValue: ({ saturation, brightness }: { saturation: number; brightness: number }) =>
        `Saturation ${saturation} %, brightness ${brightness} %`,
      imageChosen: "Image chosen",
      notSet: "not set",
    },
    de: {
      removeValue: ({ label }: { label: string }) => `${label} entfernen`,
      chooseOne: "Wähle mindestens eine Option.",
      notAnAddress: ({ text }: { text: string }) => `„${text}“ ist keine E-Mail-Adresse.`,
      tooManyAddresses: ({ max, left }: { max: number; left: number }) =>
        `Dieses Feld nimmt höchstens ${max} Adressen; ${left === 1 ? "1 wurde" : `${left} wurden`} nicht übernommen.`,
      tooManyValues: ({ max, left }: { max: number; left: number }) =>
        `Dieses Feld nimmt höchstens ${max} Werte; ${left === 1 ? "1 wurde" : `${left} wurden`} nicht übernommen.`,
      addressesAdded: ({ count }: { count: number }) => (count === 1 ? "1 Adresse hinzugefügt." : `${count} Adressen hinzugefügt.`),
      addressesRemoved: ({ count }: { count: number }) => (count === 1 ? "1 Adresse entfernt." : `${count} Adressen entfernt.`),
      chooseImage: "Bild wählen",
      changeImage: "Bild ändern",
      removeImage: "Bild entfernen",
      noImage: "Kein Bild",
      imageFailed: "Das Bild ließ sich nicht lesen. Wähle ein anderes.",
      pickColor: "Farbe wählen",
      colorArea: "Sättigung und Helligkeit",
      hue: "Farbton",
      colorCode: "Farbcode",
      color: ({ value }: { value: string }) => `Farbe ${value}`,
      hueValue: ({ degrees }: { degrees: number }) => `${degrees} Grad`,
      areaValue: ({ saturation, brightness }: { saturation: number; brightness: number }) =>
        `Sättigung ${saturation} %, Helligkeit ${brightness} %`,
      imageChosen: "Bild gewählt",
      notSet: "nicht angegeben",
    },
  },
});

export type ControlMessages = ReturnType<(typeof controlMessages)["resolve"]>["t"];

export const useControlMessages = (): (() => ControlMessages) => {
  const locale = useLocale();
  return () => controlMessages.resolve([locale()]).t;
};

export const checkControlMessages = () => controlMessages.check();
