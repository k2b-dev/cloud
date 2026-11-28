import { z } from "zod";
import { DeadlineAllDaySchema, DeadlineInputSchema, ResourceShortIdSchema } from "./contracts";

export const OverviewViewSchema = z.enum(["mine", "today", "upcoming"]);
const OverviewWorkItemSchema = z.object({
  shortId: ResourceShortIdSchema,
  spaceShortId: ResourceShortIdSchema,
  spaceName: z.string(),
  spaceColor: z.string().nullable(),
  title: z.string(),
  priority: z.enum(["low", "medium", "high", "urgent"]).nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  deadline: DeadlineInputSchema.nullable(),
  deadlineAllDay: DeadlineAllDaySchema,
  canWrite: z.boolean().describe("The reader may change the item, such as check it off"),
});
export const OverviewWorkSchema = z.object({
  view: OverviewViewSchema,
  items: z.array(OverviewWorkItemSchema),
  /** What counts today, for the first row and the agenda of the web overview; only when the caller asks for the day. */
  day: z
    .object({
      at: z.string().describe("The moment the day was read (ISO); how long until the next entry counts from it"),
      agenda: z.array(OverviewWorkItemSchema).describe("Today's first events and due items across the reader's Spaces"),
      next: OverviewWorkItemSchema.nullable().describe("The first entry of today that starts after now"),
      overdue: z.number().describe("Open tasks assigned to the reader whose due day has passed"),
      done: z
        .array(z.number())
        .describe("Tasks assigned to the reader that were completed on each of the last 14 days, oldest first, today last"),
    })
    .optional(),
  counts: z.object({ mine: z.number(), today: z.number(), upcoming: z.number() }),
});
export type OverviewView = z.infer<typeof OverviewViewSchema>;
export type OverviewWork = z.infer<typeof OverviewWorkSchema>;

/** What the first band of a Space says: tasks done per day of the last 14 days (today last), and the open tasks that need someone. */
export type SpacePulse = { done: number[]; overdue: number; unassigned: number };
