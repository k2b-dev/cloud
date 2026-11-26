import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** The words of `Setting`, resolved from the inherited render locale. */
const settingMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      changedFrom: ({ value }: { value: string }) => `changed · was ${value}`,
    },
    de: {
      changedFrom: ({ value }: { value: string }) => `geändert · vorher ${value}`,
    },
  },
});

export type SettingMessages = ReturnType<(typeof settingMessages)["resolve"]>["t"];

export const useSettingMessages = (): (() => SettingMessages) => {
  const locale = useLocale();
  return () => settingMessages.resolve([locale()]).t;
};

export const checkSettingMessages = () => settingMessages.check();
