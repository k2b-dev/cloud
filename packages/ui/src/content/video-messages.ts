import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const videoMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      videoUnsupported: "Your browser does not support video playback.",
      videoCannotPlay: "This video cannot play here",
      videoCannotPlayDescription: "Your browser cannot play this video. Download it to watch it in another app.",
    },
    de: {
      videoUnsupported: "Dein Browser unterstützt keine Videowiedergabe.",
      videoCannotPlay: "Dieses Video kann hier nicht abgespielt werden",
      videoCannotPlayDescription: "Dein Browser kann dieses Video nicht abspielen. Lade es herunter, um es in einer anderen App anzusehen.",
    },
  },
});

export type VideoMessages = ReturnType<(typeof videoMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useVideoMessages = (): (() => VideoMessages) => {
  const locale = useLocale();
  return () => videoMessages.resolve([locale()]).t;
};

export const checkVideoMessages = () => videoMessages.check();
