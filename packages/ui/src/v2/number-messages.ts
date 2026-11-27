import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/**
 * The words of a v2 number field (`Input type="number"`). A catalog of its own, so islands that use the shared
 * catalog of `@k2b/ui` never carry them.
 */
const numberMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      numberInvalid: "Enter a number.",
      numberInexact: "Too many digits for a number.",
      numberMin: ({ min }: { min: string }) => `At least ${min}.`,
      numberMax: ({ max }: { max: string }) => `At most ${max}.`,
    },
    de: {
      numberInvalid: "Gib eine Zahl ein.",
      numberInexact: "Zu viele Stellen für eine Zahl.",
      numberMin: ({ min }: { min: string }) => `Mindestens ${min}.`,
      numberMax: ({ max }: { max: string }) => `Höchstens ${max}.`,
    },
  },
});

export type NumberMessages = ReturnType<(typeof numberMessages)["resolve"]>["t"];

export const useNumberMessages = (): (() => NumberMessages) => {
  const locale = useLocale();
  return () => numberMessages.resolve([locale()]).t;
};

export const checkNumberMessages = () => numberMessages.check();
