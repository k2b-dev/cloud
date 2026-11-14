import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const thumbnailStripMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      thumbnailCurrent: "current",
      thumbnailUnsaved: "unsaved changes",
      thumbnailAdd: "Add images",
    },
    de: {
      thumbnailCurrent: "aktuell",
      thumbnailUnsaved: "ungespeicherte Änderungen",
      thumbnailAdd: "Bilder hinzufügen",
    },
  },
});

export type ThumbnailStripMessages = ReturnType<(typeof thumbnailStripMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useThumbnailStripMessages = (): (() => ThumbnailStripMessages) => {
  const locale = useLocale();
  return () => thumbnailStripMessages.resolve([locale()]).t;
};

export const checkThumbnailStripMessages = () => thumbnailStripMessages.check();
