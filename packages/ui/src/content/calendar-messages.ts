import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/**
 * The month view's own strings. They live beside the calendar instead of in the shared catalog, so applications that
 * never render a calendar do not ship them.
 */
const calendarMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      calendarMoreEvents: ({ count }: { count: number }) => `+${count} more`,
      calendarMoreEventsOn: ({ count, label }: { count: number; label: string }) => `${count} more on ${label}`,
      calendarSelectionActions: "Actions for the selected days",
      calendarQuickCreate: "New entry",
      calendarSelectedDays: ({ start, end, count }: { start: string; end: string; count: number }) => `${start} – ${end} · ${count} days`,
      calendarOpenDay: "Open day",
      calendarOpenWeek: "Open week",
      calendarOpenWeekNumber: ({ week }: { week: number }) => `Week ${week}, open week`,
      calendarClearSelection: "Clear selection",
      calendarNewEvent: "New event",
      calendarNothingPlanned: "Nothing planned.",
      calendarContinuesFrom: ({ day, month }: { day: number; month?: string }) => `from ${month ? `${month} ` : ""}${day}`,
      calendarContinuesUntil: ({ day, month }: { day: number; month?: string }) => `until ${month ? `${month} ` : ""}${day}`,
    },
    de: {
      calendarMoreEvents: ({ count }) => `+${count} weitere`,
      calendarMoreEventsOn: ({ count, label }) => `${count} weitere am ${label}`,
      calendarSelectionActions: "Aktionen für die ausgewählten Tage",
      calendarQuickCreate: "Neuer Eintrag",
      calendarSelectedDays: ({ start, end, count }) => `${start} – ${end} · ${count} Tage`,
      calendarOpenDay: "Tag öffnen",
      calendarOpenWeek: "Woche öffnen",
      calendarOpenWeekNumber: ({ week }) => `KW ${week}, Woche öffnen`,
      calendarClearSelection: "Auswahl aufheben",
      calendarNewEvent: "Neuer Termin",
      calendarNothingPlanned: "Nichts geplant.",
      calendarContinuesFrom: ({ day, month }) => `seit ${day}.${month ? ` ${month}` : ""}`,
      calendarContinuesUntil: ({ day, month }) => `bis ${day}.${month ? ` ${month}` : ""}`,
    },
  },
});

export type CalendarMessages = ReturnType<(typeof calendarMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale, like the rest of @k2b/ui. */
export const useCalendarMessages = (): (() => CalendarMessages) => {
  const locale = useLocale();
  return () => calendarMessages.resolve([locale()]).t;
};

export const checkCalendarMessages = () => calendarMessages.check();
