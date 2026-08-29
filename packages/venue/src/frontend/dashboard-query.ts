import type { CalendarView } from "@k2b/ui";
import { apiClient } from "../api/client";
import type { VenueDashboard } from "../contracts";

export type VenueDashboardSource = {
  venueId: string;
  query: {
    slotStartDate?: string;
    slotDays?: string;
    includeFeedbackEntries?: "true" | "false";
    feedbackDays?: string;
    feedbackSearch?: string;
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
  };
};

const shiftDate = (date: string, days: number): string => {
  const [year = "1970", month = "1", day = "1"] = date.split("-");
  const next = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + days, 12));
  return next.toISOString().slice(0, 10);
};

const slotWindow = (view: CalendarView, date: string): { startDate: string; days: number } =>
  view === "month" ? { startDate: shiftDate(date, -7), days: 45 } : { startDate: shiftDate(date, -7), days: 14 };

export const venueDashboardRouteScope = (input: {
  venueId: string;
  view: "shifts" | "my-shifts" | "feedback";
  calendarView: CalendarView;
  calendarDate: string;
  feedbackDays: number;
  feedbackSearch: string;
}): VenueDashboardRouteScope => {
  const slots = input.view === "shifts" ? slotWindow(input.calendarView, input.calendarDate) : { startDate: input.calendarDate, days: 14 };
  const includeFeedbackEntries = input.view === "feedback";
  const options = {
    slotStartDate: slots.startDate,
    slotDays: slots.days,
    includeFeedbackEntries,
    feedbackDays: input.feedbackDays,
    feedbackSearch: input.feedbackSearch || undefined,
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
  left.query.feedbackSearch === right.query.feedbackSearch;

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
