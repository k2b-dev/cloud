import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";

/** The words of the Accounts overview on v2 that the shared catalog does not have. */
export const overviewMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      yourAccount: "Your account",
      logs: "Logs",
      level: "Level",
      source: "Source",
      runRate: ({ rate }: { rate: number }) => `${rate} % without errors`,
      failedRuns: ({ count }: { count: number }) =>
        i18n.plural(count, "en", { one: "1 run with errors", other: `${count} runs with errors` }),
      expiredOn: ({ when }: { when: string }) => `Expired ${when}`,
    },
    de: {
      yourAccount: "Dein Konto",
      logs: "Protokolle",
      level: "Stufe",
      source: "Quelle",
      runRate: ({ rate }) => `${rate} % ohne Fehler`,
      failedRuns: ({ count }) => i18n.plural(count, "de", { one: "1 Lauf mit Fehlern", other: `${count} Läufe mit Fehlern` }),
      expiredOn: ({ when }) => `Abgelaufen am ${when}`,
    },
  },
});

export type OverviewMessages = ReturnType<typeof overviewMessages.resolve>["t"];

export const useOverviewMessages = () => {
  const locale = useLocale();
  return createMemo(() => overviewMessages.resolve([locale()]).t);
};
