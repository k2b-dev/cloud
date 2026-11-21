import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

// The word for the current stage lives with the path, not in the common catalog every component loads.
const progressPathMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { current: "current step" },
    de: { current: "aktueller Schritt" },
  },
});

export type ProgressPathMessages = ReturnType<(typeof progressPathMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useProgressPathMessages = (): (() => ProgressPathMessages) => {
  const locale = useLocale();
  return () => progressPathMessages.resolve([locale()]).t;
};

export const checkProgressPathMessages = () => progressPathMessages.check();
