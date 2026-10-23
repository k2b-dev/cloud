import { z } from "zod";
import { ResourceShortIdSchema } from "./contracts";
import { CreateTimeBlockSchema, SpaceTimeBlockSchema, UpdateTimeBlockSchema } from "./time-block-contracts";

const blockId = z.uuid().describe("Time-block UUID returned by time-block.list or time-block.read; never a task ID.");
const revision = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe("Exact revision returned by time-block.read; reread after a conflict.");

export const TimeBlockDataSchema = SpaceTimeBlockSchema.extend({
  title: z.string().max(200),
  ownerName: z.string().max(200),
  spaceName: z.string().max(100).nullable(),
  spaceColor: z.string().max(100).nullable(),
  revision,
  presentationTruncated: z.boolean().describe("True when a display name or color was shortened; title and revision remain complete."),
}).strict();
export const TimeBlockReadInputSchema = z.object({ id: blockId }).strict();
export const TimeBlockListInputSchema = z
  .object({
    from: z.string().datetime({ offset: true }).optional().describe("Inclusive start instant of the requested interval."),
    to: z.string().datetime({ offset: true }).optional().describe("Exclusive end instant, at most 366 days after from."),
    itemId: ResourceShortIdSchema.optional().describe("Public task ID from item.read or task.list; permits listing without a date range."),
    spaceId: ResourceShortIdSchema.optional().describe("Optional public Space ID returned by space.list; omit for all readable Spaces."),
    mine: z
      .boolean()
      .default(false)
      .describe("Only blocks owned by the current user or independent service account; delegated credentials act as their user."),
    cursor: z.string().min(1).max(256).optional().describe("Continuation cursor; keep every filter and limit unchanged."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(25)
      .describe("Maximum blocks per page (50 to fit the escaped JSON result budget); follow page.nextCursor until complete."),
  })
  .strict()
  .refine(
    (value) => {
      if (value.from === undefined && value.to === undefined) return value.itemId !== undefined;
      return (
        value.from !== undefined &&
        value.to !== undefined &&
        Date.parse(value.to) > Date.parse(value.from) &&
        Date.parse(value.to) - Date.parse(value.from) <= 366 * 86_400_000
      );
    },
    {
      message: "Pass an increasing range of at most 366 days, or an item ID",
      path: ["to"],
    },
  );
export const TimeBlockListDataSchema = z.array(TimeBlockDataSchema).max(50);
export const TimeBlockCreateInputSchema = CreateTimeBlockSchema.safeExtend({
  taskTitle: z
    .string()
    .min(1)
    .max(200)
    .describe("Exact current task title from item.read; pins the reviewed initial block title and rejects a concurrent rename."),
  itemId: ResourceShortIdSchema.describe("Public task ID returned by item.read or task.list; the assigned person owns the new block."),
  startsAt: CreateTimeBlockSchema.shape.startsAt.describe("Start instant with UTC offset."),
  endsAt: CreateTimeBlockSchema.shape.endsAt.describe("End instant with UTC offset, strictly after startsAt."),
  id: z.uuid().describe("Client-generated UUID. Reuse the same ID and interval when retrying this create."),
});
export const TimeBlockUpdateInputSchema = UpdateTimeBlockSchema.safeExtend({
  id: blockId,
  revision,
  title: UpdateTimeBlockSchema.shape.title.describe("Independent block title; omitted preserves it and never renames the task."),
  startsAt: UpdateTimeBlockSchema.shape.startsAt.describe("Replacement start instant with UTC offset; omitted preserves it."),
  endsAt: UpdateTimeBlockSchema.shape.endsAt.describe("Replacement end instant with UTC offset; omitted preserves it."),
}).refine((value) => value.title !== undefined || value.startsAt !== undefined || value.endsAt !== undefined, {
  message: "Supply at least one changed field",
});
export const TimeBlockDeleteInputSchema = z.object({ id: blockId, revision }).strict();
export const TimeBlockDeleteDataSchema = z.object({ id: blockId, deleted: z.literal(true) }).strict();
