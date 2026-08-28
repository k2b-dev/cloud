import { spaceMessages } from "../../../messages";
import type { Priority } from "./types";

export const priorityOptions = (locale?: string): { id: Priority | ""; label: string; icon: string }[] => {
  const { t } = spaceMessages.resolve(locale ? [locale] : []);
  return [
    { id: "urgent", label: t.urgent, icon: "ti ti-alert-circle" },
    { id: "high", label: t.high, icon: "ti ti-arrows-up" },
    { id: "medium", label: t.medium, icon: "ti ti-arrow-up" },
    { id: "low", label: t.low, icon: "ti ti-arrow-down" },
    { id: "", label: t.none, icon: "ti ti-minus" },
  ];
};
