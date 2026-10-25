import { z } from "zod";
import { DeadlineAllDaySchema, DeadlineInputSchema, ResourceShortIdSchema } from "./contracts";
import { SpaceTimeBlockSchema } from "./time-block-contracts";

export const OverviewViewSchema = z.enum(["mine", "today", "upcoming"]);
export const OverviewWorkSchema = z.object({
  view: OverviewViewSchema,
  timeBlocks: z.array(SpaceTimeBlockSchema).optional(),
  timeBlockCounts: z.object({ today: z.number(), upcoming: z.number() }).optional(),
  items: z.array(
    z.object({
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
    }),
  ),
  counts: z.object({ mine: z.number(), today: z.number(), upcoming: z.number() }),
});
export type OverviewView = z.infer<typeof OverviewViewSchema>;
export type OverviewWork = z.infer<typeof OverviewWorkSchema>;
