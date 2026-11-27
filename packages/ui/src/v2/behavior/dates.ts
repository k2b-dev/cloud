/**
 * Calendar dates from core, for v2 parts that lay out days themselves (the six weeks of `DatePicker view="weeks"`):
 * the same week start (a tag's `-u-fw-`, the locale's week info, its region), day arithmetic and names that core's
 * calendar uses, so a grid of our own and core's grids never disagree. Dates are ISO date keys ("2026-11-25").
 */
import {
  addDays,
  addMonths,
  firstDayOfWeek,
  formatDate,
  formatDateRange,
  startOfWeek,
  todayDate,
  weekday,
  weekdayNames,
} from "@ui-sdk/core/date";

export { addDays, addMonths, firstDayOfWeek, formatDate, formatDateRange, startOfWeek, todayDate, weekday, weekdayNames };
