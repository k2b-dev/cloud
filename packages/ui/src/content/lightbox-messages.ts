import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const lightboxMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      closeLightbox: "Close lightbox",
      downloadImage: "Download image",
      imageLightbox: "Image lightbox",
      imageNavigation: "Image navigation",
      nextImage: "Next image",
      previousImage: "Previous image",
      goToImage: ({ index }: { index: number }) => `Go to image ${index}`,
    },
    de: {
      closeLightbox: "Bildansicht schließen",
      downloadImage: "Bild herunterladen",
      imageLightbox: "Bildansicht",
      imageNavigation: "Bildnavigation",
      nextImage: "Nächstes Bild",
      previousImage: "Vorheriges Bild",
      goToImage: ({ index }) => `Zu Bild ${index} wechseln`,
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
