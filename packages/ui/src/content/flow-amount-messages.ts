import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const flowAmountMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      in: "incoming",
      out: "outgoing",
      none: "no amount",
      invalid: "amount unknown",
    },
    de: {
      in: "Eingang",
      out: "Ausgang",
      none: "kein Betrag",
      invalid: "Betrag unbekannt",
    },
  },
});

export type FlowAmountMessages = ReturnType<(typeof flowAmountMessages)["resolve"]>["t"];

/** Resolved from an explicit locale override, else the inherited render locale. */
export const useFlowAmountMessages = (override?: () => string | undefined): (() => FlowAmountMessages) => {
  const locale = useLocale();
  return () => flowAmountMessages.resolve([override?.() ?? locale()]).t;
};

export const checkFlowAmountMessages = () => flowAmountMessages.check();
