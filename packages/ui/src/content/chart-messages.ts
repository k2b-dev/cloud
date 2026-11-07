import { useLocale } from "../intl/locale";
import { chartMessages } from "./chart-message-catalog";

export { chartMessages } from "./chart-message-catalog";

export type ChartMessages = ReturnType<(typeof chartMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useChartMessages = (): (() => ChartMessages) => {
  const locale = useLocale();
  return () => chartMessages.resolve([locale()]).t;
};

export const checkChartMessages = () => chartMessages.check();
