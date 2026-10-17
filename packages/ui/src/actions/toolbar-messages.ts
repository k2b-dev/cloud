import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const toolbarMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      moreActions: "More actions",
    },
    de: {
      moreActions: "Weitere Aktionen",
    },
  },
});

export type ToolbarMessages = ReturnType<(typeof toolbarMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useToolbarMessages = (): (() => ToolbarMessages) => {
  const locale = useLocale();
  return () => toolbarMessages.resolve([locale()]).t;
};

export const checkToolbarMessages = () => toolbarMessages.check();
