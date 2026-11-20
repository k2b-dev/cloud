import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const inputMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      decreaseValue: "Decrease value",
      increaseValue: "Increase value",
      showPassword: "Show password",
      useColor: "Use a color",
      useTransparent: "Use transparent",
      pinDigit: ({ index, total }: { index: number; total: number }) => `PIN digit ${index} of ${total}`,
      resetTo: ({ value }: { value: string }) => `Reset to ${value}`,
      timeLetters: "hh:mm",
      notATime: "Not a time. Example: 09:30",
      timeRequired: "Enter a time.",
      earliestTime: ({ time }: { time: string }) => `${time} at the earliest.`,
      latestTime: ({ time }: { time: string }) => `${time} at the latest.`,
    },
    de: {
      decreaseValue: "Wert verringern",
      increaseValue: "Wert erhöhen",
      showPassword: "Passwort anzeigen",
      useColor: "Farbe verwenden",
      useTransparent: "Transparent verwenden",
      pinDigit: ({ index, total }) => `PIN-Ziffer ${index} von ${total}`,
      resetTo: ({ value }) => `Zurücksetzen auf ${value}`,
      timeLetters: "hh:mm",
      notATime: "Keine Uhrzeit. Beispiel: 09:30",
      timeRequired: "Bitte eine Uhrzeit eingeben.",
      earliestTime: ({ time }) => `Frühestens ${time}.`,
      latestTime: ({ time }) => `Spätestens ${time}.`,
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
