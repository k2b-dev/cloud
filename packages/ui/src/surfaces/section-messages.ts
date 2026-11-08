import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** Counts, states, and copy labels shared by every `Section` and `Field`. */
const sectionMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      noneYet: "None yet",
      loading: "Loading",
      couldNotLoad: "Could not load this.",
      copyField: ({ label }: { label: string }) => `Copy ${label}`,
    },
    de: {
      noneYet: "Noch keine",
      loading: "Lädt",
      couldNotLoad: "Konnte nicht geladen werden.",
      copyField: ({ label }) => `${label} kopieren`,
    },
  },
});

export type SectionMessages = ReturnType<(typeof sectionMessages)["resolve"]>["t"];

export const useSectionMessages = (): (() => SectionMessages) => {
  const locale = useLocale();
  return () => sectionMessages.resolve([locale()]).t;
};

export const checkSectionMessages = () => sectionMessages.check();
