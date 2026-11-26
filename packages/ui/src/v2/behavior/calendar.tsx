/**
 * Calendar behaviour for v2: one month of days as a grid. The roving tab stop, the arrow keys, PageUp and PageDown (a
 * month, with Shift a year), Home and End (the week), Enter and Space, `min` and `max`, the week start and the names
 * of the locale, today in a time zone and the grid roles screen readers hear are core's. No ui-sdk type crosses this
 * module's exports.
 */
import { calendar as calendarPrimitive } from "@ui-sdk/core/calendar";
import { type SlotComponent, slotComponent, usePrimitive } from "./adapter";

export type CalendarOptions = {
  /** The chosen day as a date key ("2026-11-24"), or `null`. */
  value?: string | null;
  onValueChange?: (value: string | null) => void;
  /** The month shown, as "2026-11". */
  month?: string;
  onMonthChange?: (month: string) => void;
  /** The earliest and the latest day that can be picked, as date keys. */
  min?: string;
  max?: string;
  /** The language of month and weekday names; the week starts where the locale starts it. */
  locale?: string;
  /** The zone that says which day today is. */
  timeZone?: string;
};

export type CalendarParts = {
  Root: SlotComponent;
  /** The month and year in words; screen readers hear it change. */
  Heading: SlotComponent;
  Previous: SlotComponent;
  Next: SlotComponent;
  /** The grid; a children function gets `weekdays` (0 is Sunday, in column order) and `weeks` of cells. */
  Grid: SlotComponent;
  Weekdays: SlotComponent;
  /** A column head: `index` from 0. */
  Weekday: SlotComponent;
  Week: SlotComponent;
  /** One day: `value` is its date key. */
  Day: SlotComponent;
  /** Moves the focus to a day, or to the day with the tab stop. */
  focus: (date?: string) => void;
};

/** A calendar of one month that always shows six weeks, so turning the month never changes its height. */
export function useCalendar(options: () => CalendarOptions = () => ({})): CalendarParts {
  const handle = usePrimitive(calendarPrimitive, () => {
    const { onValueChange, onMonthChange, ...given } = options();
    return {
      ...given,
      mode: "single",
      fixedWeeks: true,
      weekdayFormat: "short",
      onValueChange: onValueChange && ((value: unknown) => onValueChange(typeof value === "string" ? value : null)),
      onMonthChange: onMonthChange && ((month: unknown) => onMonthChange(String(month))),
    };
  });
  return {
    Root: slotComponent(handle, "root", "div"),
    Heading: slotComponent(handle, "heading", "div"),
    Previous: slotComponent(handle, "previous", "button"),
    Next: slotComponent(handle, "next", "button"),
    Grid: slotComponent(handle, "grid", "div"),
    Weekdays: slotComponent(handle, "weekdays", "div"),
    Weekday: slotComponent(handle, "weekday", "div"),
    Week: slotComponent(handle, "week", "div"),
    Day: slotComponent(handle, "day", "button"),
    focus: (date) => handle.api.focus(date),
  };
}
