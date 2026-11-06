import { apiClient } from "@/api/client";
import type { CalendarRange, CalendarSourceRead, CalendarSourceView, SourcedCalendarItem } from "./calendar-model";

export type CalendarEventsAnswer = { items: SourcedCalendarItem[]; sources: CalendarSourceRead[] };

/** Thrown when the Spaces route itself does not answer; one source failing is part of a normal answer. */
export class CalendarRequestError extends Error {}

/** Reads the chosen calendars for one range of at most six weeks; each source answers or fails on its own. */
export const fetchCalendarEvents = async (
  range: CalendarRange,
  calendars: readonly string[],
  signal?: AbortSignal,
): Promise<CalendarEventsAnswer> => {
  const response = await apiClient.calendar.events.$get(
    { query: { from: range.from, to: range.to, cal: [...calendars] } },
    { init: { signal } },
  );
  if (!response.ok) throw new CalendarRequestError(String(response.status));
  return response.json();
};

/** Asks every app again which calendars it offers this person. */
export const fetchCalendarSources = async (signal?: AbortSignal): Promise<CalendarSourceView[]> => {
  const response = await apiClient.calendar.sources.$get({}, { init: { signal } });
  if (!response.ok) throw new CalendarRequestError(String(response.status));
  return (await response.json()).sources;
};
