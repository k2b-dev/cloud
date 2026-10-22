import { z } from "zod";
import { AssignedToFilterSchema, ItemStatusSchema, ItemTypeSchema, PrioritySchema, ResourceShortIdSchema } from "./contracts";

const instant = z.string().datetime({ offset: true });
export const SpaceTimeBlockSchema = z.object({
  id: z.string().uuid(),
  itemId: ResourceShortIdSchema.nullable(),
  spaceId: ResourceShortIdSchema.nullable(),
  title: z.string(),
  startsAt: instant,
  endsAt: instant,
  ownerId: z.string().uuid(),
  ownerName: z.string(),
  spaceName: z.string().nullable(),
  spaceColor: z.string().nullable(),
  taskState: z.enum(["open", "done", "deleted", "no_access"]),
  canWrite: z.boolean().describe("Whether the owner may edit this block while assigned to its accessible task"),
  canDelete: z.boolean().describe("Whether the owner may delete this block, including after its task was deleted"),
});
export type SpaceTimeBlock = z.infer<typeof SpaceTimeBlockSchema>;
export const CreateTimeBlockSchema = z
  .object({
    id: z.string().uuid(),
    startsAt: instant,
    endsAt: instant,
  })
  .strict()
  .refine((data) => Date.parse(data.endsAt) > Date.parse(data.startsAt), {
    message: "End time must be after start time",
    path: ["endsAt"],
  });
export type CreateTimeBlock = z.infer<typeof CreateTimeBlockSchema>;
export const UpdateTimeBlockSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    startsAt: instant.optional(),
    endsAt: instant.optional(),
  })
  .strict()
  .refine((data) => !data.startsAt || !data.endsAt || Date.parse(data.endsAt) > Date.parse(data.startsAt), {
    message: "End time must be after start time",
    path: ["endsAt"],
  });
export type UpdateTimeBlock = z.infer<typeof UpdateTimeBlockSchema>;

/** Same one-year window as the existing calendar; item detail reads need no date range. */
export const TimeBlockListQuerySchema = z
  .object({
    from: instant.optional(),
    to: instant.optional(),
    itemId: ResourceShortIdSchema.optional(),
    spaceId: ResourceShortIdSchema.optional(),
    type: ItemTypeSchema.optional(),
    status: ItemStatusSchema.optional(),
    assignedTo: AssignedToFilterSchema.optional(),
    priorities: z.preprocess((value) => (typeof value === "string" ? value.split(",") : value), z.array(PrioritySchema).max(4).optional()),
    columnIds: z.preprocess(
      (value) => (typeof value === "string" ? value.split(",") : value),
      z.array(ResourceShortIdSchema).max(100).optional(),
    ),
    tagIds: z.preprocess(
      (value) => (typeof value === "string" ? value.split(",") : value),
      z.array(ResourceShortIdSchema).max(100).optional(),
    ),
    mine: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(100).default(100),
  })
  .refine(
    (data) => {
      if (data.from === undefined && data.to === undefined) return Boolean(data.itemId);
      return (
        data.from !== undefined &&
        data.to !== undefined &&
        Date.parse(data.to) > Date.parse(data.from) &&
        Date.parse(data.to) - Date.parse(data.from) <= 366 * 86_400_000
      );
    },
    {
      message: "Pass an increasing range of at most 366 days",
      path: ["to"],
    },
  );
export const SpaceTimeBlockPageSchema = z.object({
  items: z.array(SpaceTimeBlockSchema),
  total: z.number(),
  page: z.number(),
  perPage: z.number(),
  hasNext: z.boolean(),
});
