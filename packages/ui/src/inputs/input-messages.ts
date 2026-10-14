import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const inputMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      decreaseValue: "Decrease value",
      increaseValue: "Increase value",
      hidePassword: "Hide password",
      showPassword: "Show password",
      useColor: "Use a color",
      useTransparent: "Use transparent",
      pinDigit: ({ index, total }: { index: number; total: number }) => `PIN digit ${index} of ${total}`,
    },
    de: {
      decreaseValue: "Wert verringern",
      increaseValue: "Wert erhöhen",
      hidePassword: "Passwort ausblenden",
      showPassword: "Passwort anzeigen",
      useColor: "Farbe verwenden",
      useTransparent: "Transparent verwenden",
      pinDigit: ({ index, total }) => `PIN-Ziffer ${index} von ${total}`,
    },
  },
});

export type InputMessages = ReturnType<(typeof inputMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useInputMessages = (): (() => InputMessages) => {
  const locale = useLocale();
  return () => inputMessages.resolve([locale()]).t;
};

export const checkInputMessages = () => inputMessages.check();
