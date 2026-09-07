import { z } from "zod";
import { AssignedToFilterSchema, DeadlineFilterSchema, ItemActivityFilterSchema, PrioritySchema, ResourceShortIdSchema } from "./contracts";

const paging = {
  cursor: z.string().min(1).max(256).optional().describe("Opaque continuation cursor; keep all filters unchanged."),
  limit: z.number().int().min(1).max(100).default(25).describe("Maximum result entries per page."),
};
const selection = {
  spaceId: ResourceShortIdSchema.optional().describe("Omit to search all accessible Spaces."),
  assignedTo: AssignedToFilterSchema.default("all").describe("Assignment filter; me requires a user-backed actor."),
};
export const TaskFocusInputSchema = z
  .object({
    ...paging,
    ...selection,
    query: z.string().trim().max(500).default("").describe("Optional task text search."),
    deadlineFilter: DeadlineFilterSchema.default("all").describe("Deadline window in the inherited user timezone."),
    activity: ItemActivityFilterSchema.default("all").describe("Include all open tasks or only inactive tasks."),
    priority: z.array(PrioritySchema).max(4).optional().describe("Match any selected priority."),
    blocked: z.boolean().optional().describe("Filter by whether unfinished blocker tasks exist."),
  })
  .strict();
const ref = z.object({ type: z.literal("spaces.item"), id: ResourceShortIdSchema }).strict();
export const TaskFocusDataSchema = z
  .array(
    z
      .object({
        ref,
        title: z.string().max(500),
        spaceId: ResourceShortIdSchema,
        spaceName: z.string().max(200),
        columnId: ResourceShortIdSchema,
        columnName: z.string().max(200).nullable(),
        deadline: z.string().nullable(),
        priority: PrioritySchema.nullable(),
        activeBlockerCount: z.number().int().nonnegative(),
        href: z.string(),
      })
      .strict(),
  )
  .max(100);
export const EventAgendaInputSchema = z
  .object({
    ...paging,
    ...selection,
    from: z.string().datetime({ offset: true }).describe("Inclusive start instant."),
    to: z
      .string()
      .datetime({ offset: true })
      .describe("Exclusive end instant; at most 31 days after from. Split longer requests into monthly windows."),
  })
  .strict()
  .refine((value) => Date.parse(value.to) > Date.parse(value.from) && Date.parse(value.to) - Date.parse(value.from) <= 31 * 86_400_000, {
    message: "Use an ordered interval of at most 31 days",
    path: ["to"],
  });
export const EventAgendaDataSchema = z
  .array(
    z
      .object({
        ref,
        title: z.string().max(500),
        spaceId: ResourceShortIdSchema,
        spaceName: z.string().max(200),
        startsAt: z.string(),
        endsAt: z.string(),
        allDay: z.boolean(),
        location: z.string().max(500).nullable(),
        recurrenceId: z.string().nullable(),
        seriesId: ResourceShortIdSchema.nullable(),
        href: z.string(),
      })
      .strict(),
  )
  .max(100);

export const decodeWorkCursor = (cursor?: string): number => {
  if (!cursor) return 0;
  const decoded = z
    .object({ offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
    .strict()
    .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  return decoded.offset;
};
export const encodeWorkCursor = (offset: number): string => Buffer.from(JSON.stringify({ offset })).toString("base64url");

export class AgendaCursorError extends Error {}
const AgendaCursorSchema = z
  .object({ root: z.uuid().optional(), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), scope: z.string().length(32) })
  .strict();
export const decodeAgendaCursor = (cursor: string | undefined, scope: string): z.infer<typeof AgendaCursorSchema> => {
  if (!cursor) return { offset: 0, scope };
  try {
    const value = AgendaCursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (value.scope !== scope) throw new Error("Scope changed");
    return value;
  } catch {
    throw new AgendaCursorError("Invalid agenda cursor; restart the query with the current filters.");
  }
};
export const encodeAgendaCursor = (value: z.infer<typeof AgendaCursorSchema>): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
