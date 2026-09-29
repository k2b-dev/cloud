/**
 * The schedule's URL state: calendar view (`cv`), day (`cd`), the gaps filter (`gaps=1`), and the selected
 * shift (`shift`). Server pages and the workspace island build and read the same links from here.
 */

export const VENUE_CALENDAR_VIEWS = ["day", "week", "month", "mobile-month"] as const;
export type VenueCalendarView = (typeof VENUE_CALENDAR_VIEWS)[number];

/** Remembers the last calendar view per browser, so phone and desktop each keep their own. */
export const CALENDAR_VIEW_COOKIE = "venue_calendar_view";

/** Below this width a first visit without a remembered view switches once to the phone month view. */
export const PHONE_VIEWPORT_QUERY = "(max-width: 39.99rem)";
/** From this width the shift detail sits next to the calendar; below it opens as a bottom sheet. */
export const WIDE_VIEWPORT_QUERY = "(min-width: 64rem)";

export const parseCalendarView = (value: string | null | undefined): VenueCalendarView | null =>
  VENUE_CALENDAR_VIEWS.find((view) => view === value) ?? null;

/** A shift occurrence: its template's ID and the local day it takes place. */
export const slotSelectionId = (templateId: string, date: string): string => `${templateId}:${date}`;
/** One sign-up, for free time or a shift that no longer matches a slot. */
export const assignmentSelectionId = (assignmentId: string): string => `a:${assignmentId}`;

const SELECTION_PATTERN = /^(?:[0-9A-Za-z]{6}:\d{4}-\d{2}-\d{2}|a:[0-9A-Za-z]{6})$/;

/** The `shift` parameter when it names a slot or a sign-up; anything else selects nothing. */
export const parseShiftSelection = (value: string | null | undefined): string | null =>
  value && SELECTION_PATTERN.test(value) ? value : null;

export type ScheduleUrlState = {
  /** Omitted: the server uses the remembered view, as on a first visit. */
  view?: VenueCalendarView;
  date?: string;
  gaps?: boolean;
  shift?: string | null;
};

export const scheduleHref = (venueId: string, state: ScheduleUrlState = {}): `/app/venue/${string}` => {
  const params = new URLSearchParams();
  if (state.view) params.set("cv", state.view);
  if (state.date) params.set("cd", state.date);
  if (state.gaps) params.set("gaps", "1");
  if (state.shift) params.set("shift", state.shift);
  // Colons are valid in a query and keep `shift=Temp01:2026-09-29` readable.
  const query = params.toString().replaceAll("%3A", ":");
  return `/app/venue/${venueId}/shifts${query ? `?${query}` : ""}`;
};

/**
 * The view a calendar link leads to. The phone month view shows one day's agenda below the month, so its day
 * cells pick that day instead of leaving for the day view. On a phone, Month means the phone month view.
 */
export const calendarLinkView = (
  current: VenueCalendarView,
  requested: string,
  source: "view" | "date",
  phone: boolean,
): VenueCalendarView => {
  if (current === "mobile-month" && source === "date" && requested === "day") return "mobile-month";
  if (requested === "month" && phone) return "mobile-month";
  return parseCalendarView(requested) ?? "week";
};
