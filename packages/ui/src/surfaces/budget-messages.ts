import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const budgetMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      of: ({ limit }: { limit: string }) => `of ${limit}`,
      free: ({ amount }: { amount: string }) => `${amount} left`,
      near: ({ amount }: { amount: string }) => `tight · ${amount} left`,
      over: ({ amount }: { amount: string }) => `${amount} over budget`,
      used: "booked",
      expected: "expected",
      overLegend: "over budget",
      budget: "Budget",
      left: "left",
      overBy: "over",
      valueText: ({ used, expected, limit }: { used: string; expected?: string; limit: string }) =>
        `${used} booked${expected ? `, ${expected} expected` : ""}, of ${limit}`,
    },
    de: {
      of: ({ limit }: { limit: string }) => `von ${limit}`,
      free: ({ amount }: { amount: string }) => `noch ${amount} frei`,
      near: ({ amount }: { amount: string }) => `knapp · noch ${amount} frei`,
      over: ({ amount }: { amount: string }) => `${amount} über dem Budget`,
      used: "gebucht",
      expected: "erwartet",
      overLegend: "über dem Budget",
      budget: "Budget",
      left: "frei",
      overBy: "darüber",
      valueText: ({ used, expected, limit }: { used: string; expected?: string; limit: string }) =>
        `${used} gebucht${expected ? `, ${expected} erwartet` : ""}, von ${limit}`,
    },
  },
});

export type BudgetMessages = ReturnType<(typeof budgetMessages)["resolve"]>["t"];

/** Resolved from an explicit locale override, else the inherited render locale. */
export const useBudgetMessages = (override?: () => string | undefined): (() => BudgetMessages) => {
  const locale = useLocale();
  return () => budgetMessages.resolve([override?.() ?? locale()]).t;
};

export const checkBudgetMessages = () => budgetMessages.check();
