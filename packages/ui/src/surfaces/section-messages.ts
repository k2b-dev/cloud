import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** The copy label of `Field`; only `Field` reads it, so a section without fields does not carry it. */
const sectionMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      copyField: ({ label }: { label: string }) => `Copy ${label}`,
    },
    de: {
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
