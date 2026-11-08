import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const statCellMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      points: "pts",
      better: "better",
      worse: "worse",
      comparedWith: ({ label }: { label: string }) => `compared with ${label}`,
      notLoaded: "Not loaded",
      retry: "Try again",
      reload: "Reload",
      loading: "Loading",
      noValue: "No value",
    },
    de: {
      points: "Pkt.",
      better: "besser",
      worse: "schlechter",
      comparedWith: ({ label }: { label: string }) => `gegenüber ${label}`,
      notLoaded: "Nicht geladen",
      retry: "Erneut versuchen",
      reload: "Neu laden",
      loading: "Wird geladen",
      noValue: "Kein Wert",
    },
  },
});

export type StatCellMessages = ReturnType<(typeof statCellMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useStatCellMessages = (): (() => StatCellMessages) => {
  const locale = useLocale();
  return () => statCellMessages.resolve([locale()]).t;
};

/** For a caller that already holds the locale, such as table text for search and copy. */
export const resolveStatCellMessages = (locale: string): StatCellMessages => statCellMessages.resolve([locale]).t;

export const checkStatCellMessages = () => statCellMessages.check();
