import { apiClient } from "../api/client";
import type { VenueDashboard } from "../contracts";
import type { VenueCalendarView } from "./schedule-url";

export type VenueDashboardSource = {
  venueId: string;
  query: {
    slotStartDate?: string;
    slotDays?: string;
    includeFeedbackEntries?: "true" | "false";
    feedbackDays?: string;
    feedbackSearch?: string;
    feedbackComments?: "true";
    feedbackPage?: string;
  };
};

export type VenueDashboardRouteScope = {
  source: VenueDashboardSource;
  options: {
    slotStartDate: string;
    slotDays: number;
    includeFeedbackEntries: boolean;
    feedbackDays: number;
    feedbackSearch?: string;
    feedbackComments?: boolean;
    feedbackPage?: number;
  };
};

/** The date key `days` calendar days after `date`; date keys carry no time zone, so plain UTC arithmetic is exact. */
export const shiftDate = (date: string, days: number): string => {
  const [year = "1970", month = "1", day = "1"] = date.split("-");
  const next = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + days, 12));
  return next.toISOString().slice(0, 10);
};

/** The Monday on or before `date`; Venue calendars start their weeks on Monday. */
const weekStart = (date: string): string => shiftDate(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));

/** Exactly the days the calendar view shows: one day, one week, or the six weeks of a month grid. */
export const slotWindow = (view: VenueCalendarView, date: string): { startDate: string; days: number } => {
  if (view === "day") return { startDate: date, days: 1 };
  if (view === "week") return { startDate: weekStart(date), days: 7 };
  return { startDate: weekStart(`${date.slice(0, 7)}-01`), days: 42 };
};

export const venueDashboardRouteScope = (input: {
  venueId: string;
  view: "shifts" | "my-shifts" | "feedback";
  calendarView: VenueCalendarView;
  calendarDate: string;
  feedbackDays: number;
  feedbackSearch: string;
  feedbackComments: boolean;
  feedbackPage: number;
}): VenueDashboardRouteScope => {
  const slots = input.view === "shifts" ? slotWindow(input.calendarView, input.calendarDate) : { startDate: input.calendarDate, days: 14 };
  const includeFeedbackEntries = input.view === "feedback";
  const options = {
    slotStartDate: slots.startDate,
    slotDays: slots.days,
    includeFeedbackEntries,
    feedbackDays: input.feedbackDays,
    feedbackSearch: input.feedbackSearch || undefined,
    feedbackComments: includeFeedbackEntries && input.feedbackComments ? true : undefined,
    feedbackPage: includeFeedbackEntries && input.feedbackPage > 1 ? input.feedbackPage : undefined,
  };
  return {
    options,
    source: {
      venueId: input.venueId,
      query: {
        slotStartDate: options.slotStartDate,
        slotDays: String(options.slotDays),
        includeFeedbackEntries: String(options.includeFeedbackEntries) as "true" | "false",
        feedbackDays: String(options.feedbackDays),
        feedbackSearch: options.feedbackSearch,
        feedbackComments: options.feedbackComments ? "true" : undefined,
        feedbackPage: options.feedbackPage === undefined ? undefined : String(options.feedbackPage),
      },
    },
  };
};

export const sameVenueDashboardSource = (left: VenueDashboardSource, right: VenueDashboardSource): boolean =>
  left.venueId === right.venueId &&
  left.query.slotStartDate === right.query.slotStartDate &&
  left.query.slotDays === right.query.slotDays &&
  left.query.includeFeedbackEntries === right.query.includeFeedbackEntries &&
  left.query.feedbackDays === right.query.feedbackDays &&
  left.query.feedbackSearch === right.query.feedbackSearch &&
  left.query.feedbackComments === right.query.feedbackComments &&
  left.query.feedbackPage === right.query.feedbackPage;

export const loadVenueDashboard = async (
  source: VenueDashboardSource,
  abortSignal: AbortSignal,
  errorMessage = "Failed to refresh venue.",
): Promise<VenueDashboard> => {
  const response = await apiClient.venues[":id"].dashboard.$get(
    { param: { id: source.venueId }, query: source.query },
    { init: { signal: abortSignal } },
  );
  if (!response.ok) throw new Error(errorMessage);
  return await response.json();
};
