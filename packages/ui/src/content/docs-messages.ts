import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const docsMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      codeLabel: ({ title }: { title: string }) => `${title} code`,
    },
    de: {
      codeLabel: ({ title }) => `Code von ${title}`,
    },
  },
});

export type DocsMessages = ReturnType<(typeof docsMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useDocsMessages = (): (() => DocsMessages) => {
  const locale = useLocale();
  return () => docsMessages.resolve([locale()]).t;
};

export const checkDocsMessages = () => docsMessages.check();
