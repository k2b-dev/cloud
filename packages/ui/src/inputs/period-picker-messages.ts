import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** Labels of the built-in period presets and the picker's own words. */
const periodPickerMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      period: "Period",
      choosePeriod: "Choose a period",
      custom: "Custom range",
      from: "From",
      to: "To",
      backToPresets: "Back to presets",
      since: ({ date }: { date: string }) => `since ${date}`,
      days: ({ count }: { count: number }) => (count === 1 ? "1 day" : `${count} days`),
      today: "Today",
      yesterday: "Yesterday",
      "this-week": "This week",
      "last-week": "Last week",
      "this-month": "This month",
      "last-month": "Last month",
      "this-quarter": "This quarter",
      "last-quarter": "Last quarter",
      "this-year": "This year",
      "last-year": "Last year",
      all: "All time",
    },
    de: {
      period: "Zeitraum",
      choosePeriod: "Zeitraum wählen",
      custom: "Frei wählen",
      from: "Von",
      to: "Bis",
      backToPresets: "Zurück zu den Vorgaben",
      since: ({ date }) => `seit ${date}`,
      days: ({ count }) => (count === 1 ? "1 Tag" : `${count} Tage`),
      today: "Heute",
      yesterday: "Gestern",
      "this-week": "Diese Woche",
      "last-week": "Letzte Woche",
      "this-month": "Dieser Monat",
      "last-month": "Letzter Monat",
      "this-quarter": "Dieses Quartal",
      "last-quarter": "Letztes Quartal",
      "this-year": "Dieses Jahr",
      "last-year": "Letztes Jahr",
      all: "Gesamt",
    },
  },
});

export type PeriodPickerMessages = ReturnType<(typeof periodPickerMessages)["resolve"]>["t"];

const builtInKeys = new Set([
  "today",
  "yesterday",
  "this-week",
  "last-week",
  "this-month",
  "last-month",
  "this-quarter",
  "last-quarter",
  "this-year",
  "last-year",
  "all",
] as const);
type BuiltInKey = typeof builtInKeys extends Set<infer K> ? K : never;

/** The translated label of a built-in preset key, if it is one. */
export const builtInPresetLabel = (t: PeriodPickerMessages, key: string): string | undefined =>
  builtInKeys.has(key as BuiltInKey) ? t[key as BuiltInKey] : undefined;

/** Resolved from the inherited render locale. */
export const usePeriodPickerMessages = (): (() => PeriodPickerMessages) => {
  const locale = useLocale();
  return () => periodPickerMessages.resolve([locale()]).t;
};

export const resolvePeriodPickerMessages = (locale?: string): PeriodPickerMessages => periodPickerMessages.resolve([locale ?? "en"]).t;

export const checkPeriodPickerMessages = () => periodPickerMessages.check();
