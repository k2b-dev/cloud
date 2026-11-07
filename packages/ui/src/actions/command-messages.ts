import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const commandMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      commands: "Commands",
      back: ({ label }: { label: string }) => `Back from ${label}`,
      running: ({ label }: { label: string }) => `${label} is running`,
      failed: "That did not work.",
    },
    de: {
      commands: "Befehle",
      back: ({ label }: { label: string }) => `Zurück aus ${label}`,
      running: ({ label }: { label: string }) => `${label} läuft`,
      failed: "Das hat nicht geklappt.",
    },
  },
});

export type CommandMessages = ReturnType<(typeof commandMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useCommandMessages = (): (() => CommandMessages) => {
  const locale = useLocale();
  return () => commandMessages.resolve([locale()]).t;
};

export const checkCommandMessages = () => commandMessages.check();
