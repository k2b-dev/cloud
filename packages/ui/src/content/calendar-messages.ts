import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/**
 * The calendar's own strings. They live beside the calendar instead of in the shared catalog, so applications that
 * never render a calendar do not ship them.
 */
const calendarMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      calendarView: "Calendar view",
      openDate: ({ label }: { label: string }) => `Open ${label}`,
      createEventOn: ({ label }: { label: string }) => `Create event on ${label}`,
      hiddenOverlappingEvents: ({ count }: { count: number }) => `${count} hidden overlapping events`,
      calendarEventTime: ({ title, start, end }: { title: string; start: string; end: string }) => `${title}, ${start} to ${end}`,
      weekShort: "Wk",
      noEvents: "No events",
      moveEvent: "Move event",
      resizeEvent: "Resize event",
      calendarTouchMove: "Hold until highlighted, then drag.",
      calendarTouchResize: "Hold a resize handle until highlighted, then drag to resize.",
      calendarMoveDayKeys: "Alt+Left/Right moves one day.",
      calendarMoveTimeKeys: "Alt+Up/Down moves 15 minutes; Alt+Left/Right moves one day.",
      calendarResizeDayKeys: "Alt+Shift+Left/Right changes the end by one day.",
      calendarResizeTimeKeys: "Alt+Shift+Up/Down changes the end by 15 minutes; Alt+Shift+Left/Right by one day.",
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
      calendarDuration: ({ minutes }: { minutes: number }) => {
        if (minutes < 60) return `${minutes} min`;
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        return `${hours} hr${rest ? ` ${rest} min` : hours === 1 ? "" : "s"}`;
      },
      calendarFree: ({ duration }: { duration: string }) => `${duration} free`,
      calendarCreateAt: ({ start, end }: { start: string; end: string }) => `Create event ${start}–${end}`,
      calendarFreeAction: ({
        duration,
        from,
        to,
        start,
        end,
      }: {
        duration: string;
        from: string;
        to: string;
        start: string;
        end: string;
      }) => `${duration} free, ${from} to ${to}. Create event ${start}–${end}`,
      calendarRemaining: ({ duration }: { duration: string }) => `${duration} left`,
      calendarSoon: ({ title, duration }: { title: string; duration: string }) => `${title} in ${duration}`,
      calendarNight: ({ from, to }: { from: string; to: string }) => `Night · ${from} → ${to}`,
      calendarNightHours: ({ from, to }: { from: string; to: string }) => `Night · ${from}–${to}`,
      calendarFoldNight: "Fold",
      calendarOpenNight: "Open the night",
      calendarFoldNights: "Fold the nights",
      calendarOpenNights: ({ from, to }: { from: string; to: string }) => `Open the nights, ${from} to ${to}`,
      calendarUntil: ({ time }: { time: string }) => `until ${time}`,
      calendarNothingPlannedShort: "Nothing planned",
      calendarUnfoldDays: ({ count }: { count: number }): string => (count === 1 ? "Show day" : "Show days"),
      calendarDayCount: ({ count }: { count: number }) => `${count} days`,
      calendarDaySummary: ({ events, tasks }: { events: number; tasks: number }) =>
        [events ? `${events} ${events === 1 ? "event" : "events"}` : "", tasks ? `${tasks} ${tasks === 1 ? "to-do" : "to-dos"}` : ""]
          .filter(Boolean)
          .join(" · "),
      calendarMoreDays: "More days load as you scroll …",
      calendarAllDayRow: "all day",
      calendarAllDayRowShort: "all day",
      calendarAllDayAndDue: "All day and due",
      calendarDone: ({ title }: { title: string }) => `Done: ${title}`,
      calendarAllDone: "All done for today",
      calendarAllDoneShort: "All done",
      calendarDue: ({ time }: { time: string }) => `due ${time}`,
      calendarFits: "fits",
      calendarTooShort: ({ duration }: { duration: string }) => `${duration} too short`,
      calendarOverlaps: ({ title }: { title: string }) => `overlaps “${title}”`,
      calendarWeekNumber: ({ week }: { week: number }) => `W ${week}`,
      calendarWeek: "Week",
      calendarDays: "Days",
      calendarKeyboardHelp: "Arrow keys move between days, events, and free time. Enter opens or creates, Space checks off.",
      calendarDayKeyboardHelp: "Tab moves through the events and free time of each day. Enter opens or creates, Space checks off.",
      calendarShortcuts: "Keyboard shortcuts",
      calendarShortcutsNote: "Shortcuts work anywhere on this page, except while you type in a text field or a dialog is open.",
      calendarCommandToday: "Today",
      calendarCommandTodayDescription: "Show today in the calendar",
      calendarCommandNext: "Next",
      calendarCommandNextDescription: "Show the next day, week, month, or year",
      calendarCommandPrevious: "Previous",
      calendarCommandPreviousDescription: "Show the previous day, week, month, or year",
      calendarCommandView: ({ view }: { view: string }) => `${view} view`,
      calendarCommandViewDescription: ({ view }: { view: string }) => `Switch the calendar to the ${view.toLowerCase()} view`,
      calendarCommandGoTo: "Go to",
      calendarCommandGoToDescription: "Jump to a date or a week number",
      calendarGoToPlaceholder: "Date, such as 3/15, Friday, March, or W 12",
      calendarGoToHint: "Enter a date, a weekday, a month, or a week number.",
      calendarGoToUnknown: "Not recognized.",
      calendarGoToGo: "Go",
    },
    de: {
      calendarView: "Kalenderansicht",
      openDate: ({ label }) => `${label} öffnen`,
      createEventOn: ({ label }) => `Termin am ${label} erstellen`,
      hiddenOverlappingEvents: ({ count }) => `${count} ausgeblendete überlappende Termine`,
      calendarEventTime: ({ title, start, end }) => `${title}, ${start} bis ${end}`,
      weekShort: "KW",
      noEvents: "Keine Termine",
      moveEvent: "Termin verschieben",
      resizeEvent: "Termindauer ändern",
      calendarTouchMove: "Gedrückt halten, bis der Eintrag hervorgehoben ist, dann ziehen.",
      calendarTouchResize: "Einen Ziehgriff gedrückt halten, bis er hervorgehoben ist, dann zum Ändern der Dauer ziehen.",
      calendarMoveDayKeys: "Alt+Links/Rechts verschiebt um einen Tag.",
      calendarMoveTimeKeys: "Alt+Hoch/Runter verschiebt um 15 Minuten; Alt+Links/Rechts um einen Tag.",
      calendarResizeDayKeys: "Alt+Umschalt+Links/Rechts ändert das Ende um einen Tag.",
      calendarResizeTimeKeys: "Alt+Umschalt+Hoch/Runter ändert das Ende um 15 Minuten; Alt+Umschalt+Links/Rechts um einen Tag.",
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
      calendarDuration: ({ minutes }) => {
        if (minutes < 60) return `${minutes} Min`;
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        return rest ? `${hours} Std. ${rest}` : `${hours} Std.`;
      },
      calendarFree: ({ duration }) => `${duration} frei`,
      calendarCreateAt: ({ start, end }) => `Termin ${start}–${end} anlegen`,
      calendarFreeAction: ({ duration, from, to, start, end }) => `${duration} frei, ${from} bis ${to}. Termin ${start}–${end} anlegen`,
      calendarRemaining: ({ duration }) => `noch ${duration}`,
      calendarSoon: ({ title, duration }) => `${title} in ${duration}`,
      calendarNight: ({ from, to }) => `Nacht · ${from} → ${to}`,
      calendarNightHours: ({ from, to }) => `Nacht · ${from}–${to}`,
      calendarFoldNight: "einklappen",
      calendarOpenNight: "Nacht ausklappen",
      calendarFoldNights: "Nächte einklappen",
      calendarOpenNights: ({ from, to }) => `Nächte ausklappen, ${from}–${to} Uhr`,
      calendarUntil: ({ time }) => `bis ${time}`,
      calendarNothingPlannedShort: "Nichts geplant",
      calendarUnfoldDays: ({ count }) => (count === 1 ? "Tag aufklappen" : "Tage aufklappen"),
      calendarDayCount: ({ count }) => `${count} Tage`,
      calendarDaySummary: ({ events, tasks }) =>
        [events ? `${events} ${events === 1 ? "Termin" : "Termine"}` : "", tasks ? `${tasks} ${tasks === 1 ? "To-do" : "To-dos"}` : ""]
          .filter(Boolean)
          .join(" · "),
      calendarMoreDays: "Weitere Tage laden beim Scrollen …",
      calendarAllDayRow: "ganztägig",
      calendarAllDayRowShort: "ganzt.",
      calendarAllDayAndDue: "Ganztägig und fällig",
      calendarDone: ({ title }) => `Erledigt: ${title}`,
      calendarAllDone: "Alles für heute erledigt",
      calendarAllDoneShort: "Alles erledigt",
      calendarDue: ({ time }) => `fällig ${time}`,
      calendarFits: "passt",
      calendarTooShort: ({ duration }) => `${duration} zu kurz`,
      calendarOverlaps: ({ title }) => `überschneidet „${title}“`,
      calendarWeekNumber: ({ week }) => `KW ${week}`,
      calendarWeek: "Woche",
      calendarDays: "Tage",
      calendarKeyboardHelp: "Pfeiltasten wechseln zwischen Tagen, Terminen und freier Zeit. Enter öffnet oder legt an, Leertaste hakt ab.",
      calendarDayKeyboardHelp:
        "Tab wechselt zwischen den Terminen und der freien Zeit jedes Tages. Enter öffnet oder legt an, Leertaste hakt ab.",
      calendarShortcuts: "Tastenkürzel",
      calendarShortcutsNote: "Kürzel wirken überall auf dieser Seite, nur nicht beim Tippen in einem Eingabefeld oder bei offenem Dialog.",
      calendarCommandToday: "Heute",
      calendarCommandTodayDescription: "Im Kalender heute zeigen",
      calendarCommandNext: "Weiter",
      calendarCommandNextDescription: "Nächsten Tag, nächste Woche, nächsten Monat oder nächstes Jahr zeigen",
      calendarCommandPrevious: "Zurück",
      calendarCommandPreviousDescription: "Vorigen Tag, vorige Woche, vorigen Monat oder voriges Jahr zeigen",
      calendarCommandView: ({ view }) => `Ansicht ${view}`,
      calendarCommandViewDescription: ({ view }) => `Den Kalender als ${view} zeigen`,
      calendarCommandGoTo: "Gehe zu",
      calendarCommandGoToDescription: "Zu einem Datum oder einer Kalenderwoche springen",
      calendarGoToPlaceholder: "Datum, z. B. 15.3., Freitag, März oder KW 12",
      calendarGoToHint: "Datum, Wochentag, Monat oder Kalenderwoche eingeben.",
      calendarGoToUnknown: "Nicht erkannt.",
      calendarGoToGo: "Springen",
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
