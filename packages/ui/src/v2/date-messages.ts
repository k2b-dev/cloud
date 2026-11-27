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
      previousWeeks: "Six weeks back",
      nextWeeks: "Six weeks ahead",
      time: "Time",
      apply: "Apply",
      clear: "Clear",
      openCalendar: "Open calendar",
      unreadable: "Not a date. Type it as on the calendar, such as 24.11.2026.",
      empty: "Empty",
      timeUnreadable: ({ example }: { example: string }) => `Not a time. Write it like ${example}.`,
    },
    de: {
      calendar: "Kalender",
      previousMonth: "Vorheriger Monat",
      nextMonth: "Nächster Monat",
      previousWeeks: "Sechs Wochen zurück",
      nextWeeks: "Sechs Wochen weiter",
      time: "Uhrzeit",
      apply: "Übernehmen",
      clear: "Leeren",
      openCalendar: "Kalender öffnen",
      unreadable: "Kein Datum. Schreib es wie im Kalender, etwa 24.11.2026.",
      empty: "leer",
      timeUnreadable: ({ example }: { example: string }) => `Keine Uhrzeit. Schreib sie wie ${example}.`,
    },
  },
});

export type DateMessages = ReturnType<(typeof dateMessages)["resolve"]>["t"];

export const useDateMessages = (): (() => DateMessages) => {
  const locale = useLocale();
  return () => dateMessages.resolve([locale()]).t;
};

export const checkDateMessages = () => dateMessages.check();
