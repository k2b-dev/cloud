import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/** The words of DatePicker and DateInput; month and weekday names come from the locale itself. */
const dateMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      calendar: "Calendar",
      previousMonth: "Previous month",
      nextMonth: "Next month",
      time: "Time",
      apply: "Apply",
      clear: "Clear",
      openCalendar: "Open calendar",
      unreadable: "Not a date. Type it as on the calendar, such as 24.11.2026.",
      empty: "Empty",
    },
    de: {
      calendar: "Kalender",
      previousMonth: "Vorheriger Monat",
      nextMonth: "Nächster Monat",
      time: "Uhrzeit",
      apply: "Übernehmen",
      clear: "Leeren",
      openCalendar: "Kalender öffnen",
      unreadable: "Kein Datum. Schreib es wie im Kalender, etwa 24.11.2026.",
      empty: "leer",
    },
  },
});

export type DateMessages = ReturnType<(typeof dateMessages)["resolve"]>["t"];

export const useDateMessages = (): (() => DateMessages) => {
  const locale = useLocale();
  return () => dateMessages.resolve([locale()]).t;
};

export const checkDateMessages = () => dateMessages.check();
