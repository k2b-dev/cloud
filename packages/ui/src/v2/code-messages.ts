import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** The words of CodeBlock, resolved from the inherited render locale. */
const codeMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      copied: "Copied",
      copyFailed: "Copying did not work; select the code and copy it with your keyboard.",
      show: "Show",
      hide: "Hide",
      wrap: "Wrap long lines",
      hidden: "Hidden until you press Show",
      showAll: ({ lines }: { lines: string }) => `Show all (${lines} lines)`,
    },
    de: {
      copied: "Kopiert",
      copyFailed: "Kopieren hat nicht geklappt; markiere den Code und kopiere ihn mit der Tastatur.",
      show: "Zeigen",
      hide: "Verbergen",
      wrap: "Lange Zeilen umbrechen",
      hidden: "Verborgen, bis du „Zeigen“ drückst",
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
