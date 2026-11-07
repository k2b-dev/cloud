import { z } from "zod";
import { CALENDAR_SOURCE_PAGE_LIMIT, CalendarDescriptorSchema, CalendarItemSchema } from "./calendar-source";
import { CapabilityAppIdSchema } from "./capabilities";

/** Interactive calendar request budget: six elapsed weeks. */
export const CALENDAR_VIEW_MAX_RANGE_MS = 42 * 24 * 60 * 60 * 1000;
export const CalendarViewRangeSchema = z
  .object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) })
  .strict()
  .refine(({ from, to }) => Date.parse(to) > Date.parse(from), "to must be after from")
  .refine(({ from, to }) => Date.parse(to) - Date.parse(from) <= CALENDAR_VIEW_MAX_RANGE_MS, "Range exceeds 42 elapsed days");
export const CalendarSourceErrorSchema = z.object({ code: z.string(), retryable: z.boolean() });
export const CalendarSourceStateSchema = z.enum(["ok", "pending", "failed", "truncated"]);
export const CalendarSourceSummarySchema = z.object({
  appId: CapabilityAppIdSchema,
  state: CalendarSourceStateSchema,
  error: CalendarSourceErrorSchema.nullable(),
});
export const CalendarSourceListEntrySchema = z.object({
  appId: CapabilityAppIdSchema,
  name: z.string(),
  icon: z.string().nullable(),
  state: z.enum(["ok", "failed"]),
  error: CalendarSourceErrorSchema.nullable(),
  calendars: z.array(CalendarDescriptorSchema).max(CALENDAR_SOURCE_PAGE_LIMIT),
});
export const CalendarReadResultSchema = z.object({
  items: z.array(CalendarItemSchema.and(z.object({ appId: CapabilityAppIdSchema }))),
  sources: z.array(CalendarSourceSummarySchema),
});
export type CalendarSourceState = z.output<typeof CalendarSourceStateSchema>;
export type CalendarSourceSummary = z.output<typeof CalendarSourceSummarySchema>;
export type CalendarSourceListEntry = z.output<typeof CalendarSourceListEntrySchema>;
export type CalendarReadResult = z.output<typeof CalendarReadResultSchema>;
export type CalendarSelection = { appId: string; calendarId: string };
