import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** Counts and list folding shared by detail panel sections and discussions. */
const detailPanelMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      noneYet: "None yet",
      showOlder: ({ count }: { count: number }) => `Show ${count} older`,
      showMore: ({ count }: { count: number }) => `Show ${count} more`,
      showLess: "Show less",
      moreActions: "More actions",
    },
    de: {
      noneYet: "Noch keine",
      showOlder: ({ count }) => `${count} ältere anzeigen`,
      showMore: ({ count }) => `${count} weitere anzeigen`,
      showLess: "Weniger anzeigen",
      moreActions: "Weitere Aktionen",
    },
  },
});

export type DetailPanelMessages = ReturnType<(typeof detailPanelMessages)["resolve"]>["t"];

export const useDetailPanelMessages = (): (() => DetailPanelMessages) => {
  const locale = useLocale();
  return () => detailPanelMessages.resolve([locale()]).t;
};

export const checkDetailPanelMessages = () => detailPanelMessages.check();
