import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const resourceMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      resourceUntitled: "Untitled",
      resourceNoAccess: "No access",
      resourceDeleted: "Item deleted",
      resourceUnavailable: "Not available right now",
    },
    de: {
      resourceUntitled: "Ohne Titel",
      resourceNoAccess: "Kein Zugriff",
      resourceDeleted: "Element gelöscht",
      resourceUnavailable: "Gerade nicht verfügbar",
    },
  },
});

export type ResourceMessages = ReturnType<(typeof resourceMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useResourceMessages = (): (() => ResourceMessages) => {
  const locale = useLocale();
  return () => resourceMessages.resolve([locale()]).t;
};

export const checkResourceMessages = () => resourceMessages.check();
