import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** The words of CodeBlock, resolved from the inherited render locale. */
const codeMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      copied: "Copied",
      copyFailed: "Copying did not work; select the code and copy it with your keyboard.",
      copyFailedHidden: "Copying did not work; press Show, then select the code and copy it with your keyboard.",
      show: "Show",
      wrap: "Wrap long lines",
      hiddenName: ({ name }: { name: string }) => `${name}, hidden`,
      showAll: ({ lines }: { lines: string }) => `Show all (${lines} lines)`,
    },
    de: {
      copied: "Kopiert",
      copyFailed: "Kopieren hat nicht geklappt; markiere den Code und kopiere ihn mit der Tastatur.",
      copyFailedHidden: "Kopieren hat nicht geklappt; drücke „Zeigen“, markiere den Code und kopiere ihn mit der Tastatur.",
      show: "Zeigen",
      wrap: "Lange Zeilen umbrechen",
      hiddenName: ({ name }: { name: string }) => `${name}, verborgen`,
      showAll: ({ lines }: { lines: string }) => `Alles zeigen (${lines} Zeilen)`,
    },
  },
});

export type CodeMessages = ReturnType<(typeof codeMessages)["resolve"]>["t"];

export const useCodeMessages = (): (() => CodeMessages) => {
  const locale = useLocale();
  return () => codeMessages.resolve([locale()]).t;
};

export const checkCodeMessages = () => codeMessages.check();
