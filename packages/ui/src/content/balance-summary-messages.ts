import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const balanceSummaryMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { start: "Start", end: "End", in: "in", out: "out" },
    de: { start: "Anfang", end: "Ende", in: "rein", out: "raus" },
  },
});

export type BalanceSummaryMessages = ReturnType<(typeof balanceSummaryMessages)["resolve"]>["t"];

/** Resolved from an explicit locale override, else the inherited render locale. */
export const useBalanceSummaryMessages = (override?: () => string | undefined): (() => BalanceSummaryMessages) => {
  const locale = useLocale();
  return () => balanceSummaryMessages.resolve([override?.() ?? locale()]).t;
};

export const checkBalanceSummaryMessages = () => balanceSummaryMessages.check();
