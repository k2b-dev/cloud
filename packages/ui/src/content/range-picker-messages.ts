import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const rangePickerMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      window: "Window",
    },
    de: {
      window: "Fenster",
    },
  },
});

export type RangePickerMessages = ReturnType<(typeof rangePickerMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useRangePickerMessages = (): (() => RangePickerMessages) => {
  const locale = useLocale();
  return () => rangePickerMessages.resolve([locale()]).t;
};

export const checkRangePickerMessages = () => rangePickerMessages.check();
