import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const renderErrorMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      couldNotDisplayContent: "This content could not be displayed.",
    },
    de: {
      couldNotDisplayContent: "Dieser Inhalt konnte nicht angezeigt werden.",
    },
  },
});

export type RenderErrorMessages = ReturnType<(typeof renderErrorMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useRenderErrorMessages = (): (() => RenderErrorMessages) => {
  const locale = useLocale();
  return () => renderErrorMessages.resolve([locale()]).t;
};

export const checkRenderErrorMessages = () => renderErrorMessages.check();
