import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const flowAmountMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      in: "incoming",
      out: "outgoing",
      none: "no amount",
    },
    de: {
      in: "Eingang",
      out: "Ausgang",
      none: "kein Betrag",
    },
  },
});

export type FlowAmountMessages = ReturnType<(typeof flowAmountMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useFlowAmountMessages = (): (() => FlowAmountMessages) => {
  const locale = useLocale();
  return () => flowAmountMessages.resolve([locale()]).t;
};

export const checkFlowAmountMessages = () => flowAmountMessages.check();
