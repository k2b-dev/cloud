import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** The phone menu sheet's own words; they load with the sheet, so menus without one do not carry them. */
const menuSheetMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      menuBack: ({ menu }: { menu: string }) => `Back from ${menu}`,
    },
    de: {
      menuBack: ({ menu }: { menu: string }) => `Zurück aus ${menu}`,
    },
  },
});

export type MenuSheetMessages = ReturnType<(typeof menuSheetMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useMenuSheetMessages = (): (() => MenuSheetMessages) => {
  const locale = useLocale();
  return () => menuSheetMessages.resolve([locale()]).t;
};

export const checkMenuSheetMessages = () => menuSheetMessages.check();
