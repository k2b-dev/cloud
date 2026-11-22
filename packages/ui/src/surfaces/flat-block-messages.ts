import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** Words of the flat building blocks: an area's disclosure and a fact group's pencil. */
const flatBlockMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      showArea: ({ name }: { name: string }) => `Show ${name}`,
      hideArea: ({ name }: { name: string }) => `Hide ${name}`,
      editFacts: ({ title }: { title: string }) => `Edit ${title}`,
    },
    de: {
      showArea: ({ name }) => `${name} aufklappen`,
      hideArea: ({ name }) => `${name} zuklappen`,
      editFacts: ({ title }) => `${title} bearbeiten`,
    },
  },
});

export type FlatBlockMessages = ReturnType<(typeof flatBlockMessages)["resolve"]>["t"];

export const useFlatBlockMessages = (): (() => FlatBlockMessages) => {
  const locale = useLocale();
  return () => flatBlockMessages.resolve([locale()]).t;
};

export const checkFlatBlockMessages = () => flatBlockMessages.check();
