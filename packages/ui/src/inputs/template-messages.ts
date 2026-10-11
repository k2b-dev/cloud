import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const templateMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      templateEditorPlaceholder: "Write HTML with Liquid values like {{ APP_NAME }}...",
      templatePreview: "Template preview",
    },
    de: {
      templateEditorPlaceholder: "HTML mit Liquid-Werten wie {{ APP_NAME }} schreiben...",
      templatePreview: "Vorlagenvorschau",
    },
  },
});

export type TemplateMessages = ReturnType<(typeof templateMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useTemplateMessages = (): (() => TemplateMessages) => {
  const locale = useLocale();
  return () => templateMessages.resolve([locale()]).t;
};

export const checkTemplateMessages = () => templateMessages.check();
