import {
  CalendarReadResultSchema,
  CalendarSourceListEntrySchema,
  CalendarViewRangeSchema,
  CapabilityAppIdSchema,
} from "@k2b/cloud/contracts";
import { z } from "zod";

export const CalendarSelectionSchema = z.object({ appId: CapabilityAppIdSchema, calendarId: z.string().min(1).max(2048) }).strict();
export const CalendarSelectionsSchema = z.array(CalendarSelectionSchema).max(100);
export const CalendarSourcesResponseSchema = z.object({ sources: z.array(CalendarSourceListEntrySchema) });
export const CalendarEventsResponseSchema = CalendarReadResultSchema;
export const CalendarRangeSchema = CalendarViewRangeSchema;
export const CalendarViewQuerySchema = z.object({
  from: z.string().describe("Inclusive timestamp with an explicit offset."),
  to: z.string().describe("Exclusive timestamp with an explicit offset; at most 42 elapsed days after from."),
  cal: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Repeat appId:calendarId for each selected calendar; omit for an empty selection."),
});
export type CalendarSelection = z.output<typeof CalendarSelectionSchema>;
export type CalendarSourcesResponse = z.output<typeof CalendarSourcesResponseSchema>;
export type CalendarEventsResponse = z.output<typeof CalendarEventsResponseSchema>;
/** Calendar IDs are opaque and may contain further colons. */
export const parseCalendarSelections = (values: string[]): CalendarSelection[] =>
  CalendarSelectionsSchema.parse(
    values.map((value) => {
      const colon = value.indexOf(":");
      return { appId: colon < 0 ? "" : value.slice(0, colon), calendarId: colon < 0 ? "" : value.slice(colon + 1) };
    }),
  );
