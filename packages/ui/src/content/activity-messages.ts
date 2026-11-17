import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** Words of `ActivityList` and `ActivityCard`; the sentences of the entries come from the application. */
const activityMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      activityTitle: "History",
      activityToday: "Today",
      activityYesterday: "Yesterday",
      activityOlder: "More than a week ago",
      activityAutomatic: "automatic",
      activityAll: ({ count }: { count: number }) => `All ${count}`,
      activityEmpty: "Nothing has happened yet.",
      activityError: "The history did not load.",
      activityReload: "Reload",
      activityFilter: "Filter by kind",
    },
    de: {
      activityTitle: "Verlauf",
      activityToday: "Heute",
      activityYesterday: "Gestern",
      activityOlder: "Vor über einer Woche",
      activityAutomatic: "automatisch",
      activityAll: ({ count }) => `Alle ${count}`,
      activityEmpty: "Noch nichts passiert.",
      activityError: "Der Verlauf ließ sich nicht laden.",
      activityReload: "Neu laden",
      activityFilter: "Filter nach Art",
    },
  },
});

export type ActivityMessages = ReturnType<(typeof activityMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useActivityMessages = (): (() => ActivityMessages) => {
  const locale = useLocale();
  return () => activityMessages.resolve([locale()]).t;
};

/** Outside a component, such as when a dialog opens: the given locale, else the document's language. */
export const resolveActivityMessages = (locale?: string): ActivityMessages =>
  activityMessages.resolve([locale ?? (typeof document === "undefined" ? activityMessages.baseLocale : document.documentElement.lang)]).t;

export const checkActivityMessages = () => activityMessages.check();
