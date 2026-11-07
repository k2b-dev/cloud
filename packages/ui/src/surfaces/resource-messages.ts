import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const resourceMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      resourceUntitled: "Untitled",
      resourceNoAccess: "Item not available",
      resourceDeleted: "Item deleted",
      resourceUnavailable: "Not available right now",
      resourceKind: "Cloud element",
      resourceNoAccessHint: "You have no access. Title and content stay hidden.",
    },
    de: {
      resourceUntitled: "Ohne Titel",
      resourceNoAccess: "Element nicht verfügbar",
      resourceDeleted: "Element gelöscht",
      resourceUnavailable: "Gerade nicht verfügbar",
      resourceKind: "Cloud-Element",
      resourceNoAccessHint: "Du hast keinen Zugriff. Titel und Inhalt bleiben verborgen.",
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
