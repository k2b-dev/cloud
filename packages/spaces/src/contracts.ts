import { CloudResourceRefSchema } from "@valentinkolb/cloud/contracts";
import { z } from "zod";
import { CompletionInputSchema } from "./work-contracts";

// PostgreSQL uuid text format (accepts PostgreSQL's broader non-RFC version/variant values too).
const UuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export const ResourceShortIdSchema = z.string().regex(/^[0-9A-Za-z]{6}$/);

export const SpaceSchema = z.object({
  id: ResourceShortIdSchema.describe("Space ID"),
  name: z.string().describe("Space name"),
  description: z.string().nullable().describe("Space description"),
  color: z.string().describe("Space color (hex)"),
  icalToken: z.string().nullable().describe("iCal export token"),
  createdAt: z.string().describe("Creation timestamp (ISO)"),
  updatedAt: z.string().describe("Last update timestamp (ISO)"),
});
export type Space = z.infer<typeof SpaceSchema>;

export const SpaceColumnSchema = z.object({
  id: ResourceShortIdSchema.describe("Column ID"),
  spaceId: ResourceShortIdSchema.describe("Parent space ID"),
  name: z.string().describe("Column name"),
  color: z.string().nullable().describe("Column color (hex)"),
  rank: z.string().describe("Column ordering rank"),
  isDone: z.boolean().describe("Items in this column are considered done"),
});
export type SpaceColumn = z.infer<typeof SpaceColumnSchema>;

export const SpaceTagSchema = z.object({
  id: ResourceShortIdSchema.describe("Tag ID"),
  spaceId: ResourceShortIdSchema.describe("Parent space ID"),
  name: z.string().describe("Tag name"),
  color: z.string().describe("Tag color (hex)"),
});
export type SpaceTag = z.infer<typeof SpaceTagSchema>;

export const SpaceWormholeTargetSchema = z.object({
  spaceId: ResourceShortIdSchema.describe("Destination space ID"),
  spaceName: z.string().describe("Destination space name"),
  spaceColor: z.string().describe("Destination space color (hex)"),
  columnId: ResourceShortIdSchema.describe("Destination column ID"),
  columnName: z.string().describe("Destination column name"),
  columnIsDone: z.boolean().describe("Whether the destination column completes items"),
});
export type SpaceWormholeTarget = z.infer<typeof SpaceWormholeTargetSchema>;

export const SpaceWormholeSchema = z.object({
  id: ResourceShortIdSchema.describe("Wormhole ID"),
  sourceSpaceId: ResourceShortIdSchema.describe("Source space ID"),
  color: z.string().describe("Wormhole color (hex)"),
  rank: z.string().describe("Wormhole ordering rank"),
  target: SpaceWormholeTargetSchema.nullable().describe("Destination metadata, or null when it is no longer manageable"),
  createdAt: z.string().describe("Creation timestamp (ISO)"),
  updatedAt: z.string().describe("Last update timestamp (ISO)"),
});
export type SpaceWormhole = z.infer<typeof SpaceWormholeSchema>;

export const SpaceWormholeDestinationSchema = z.object({
  spaceId: ResourceShortIdSchema.describe("Destination space ID"),
  spaceName: z.string().describe("Destination space name"),
  spaceColor: z.string().describe("Destination space color (hex)"),
  columns: z.array(SpaceColumnSchema).describe("Columns in the destination space"),
});
export type SpaceWormholeDestination = z.infer<typeof SpaceWormholeDestinationSchema>;

export const PrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
export type Priority = z.infer<typeof PrioritySchema>;

export const EstimatedDurationMinutesSchema = z.number().int().min(1).max(2_147_483_647);

export const RecurrenceSchema = z.object({
  rrule: z.string().min(1).describe("RFC 5545 RRULE string"),
  dtstart: z.string().datetime().nullable().optional().describe("Recurrence series start timestamp (ISO)"),
  exdate: z.array(z.string().datetime()).default([]).describe("Excluded recurrence instance timestamps (ISO)"),
});
export type Recurrence = z.infer<typeof RecurrenceSchema>;

export const SpaceItemAssigneeSchema = z.object({
  id: UuidSchema.describe("User UUID"),
  displayName: z.string().describe("User display name"),
  avatarHash: z.string().nullable().describe("User avatar hash"),
});
export type SpaceItemAssignee = z.infer<typeof SpaceItemAssigneeSchema>;

export const SpaceAssignableUserSchema = SpaceItemAssigneeSchema.extend({
  description: z.string().optional().describe("Short source hint for the picker"),
});
export type SpaceAssignableUser = z.infer<typeof SpaceAssignableUserSchema>;

export const SpaceItemSchema = z.object({
  id: ResourceShortIdSchema.describe("Item ID"),
  spaceId: ResourceShortIdSchema.describe("Parent space ID"),
  columnId: ResourceShortIdSchema.describe("Current column ID"),
  title: z.string().describe("Item title"),
  description: z.string().nullable().describe("Item description (markdown)"),
  location: z.string().nullable().describe("Event location"),
  url: z.string().nullable().describe("Event URL"),
  startsAt: z.string().nullable().describe("Event start time (ISO)"),
  endsAt: z.string().nullable().describe("Event end time (ISO)"),
  allDay: z.boolean().default(false).describe("Whether the item is an all-day event"),
  deadline: z.string().nullable().describe("Todo deadline (ISO)"),
  estimatedDurationMinutes: EstimatedDurationMinutesSchema.nullable().describe("Estimated task duration in minutes"),
  activeBlockerCount: z.number().int().nonnegative().describe("Number of incomplete tasks that currently block this task"),
  priority: PrioritySchema.nullable().describe("Item priority"),
  recurrence: RecurrenceSchema.nullable().describe("Recurring event series data"),
  recurringEventId: ResourceShortIdSchema.nullable().describe("Parent recurring event ID for overrides"),
  recurrenceId: z.string().nullable().describe("Original occurrence timestamp (ISO) for overrides"),
  rank: z.string().describe("Item ordering rank within a column"),
  completedAt: z.string().nullable().describe("Completion timestamp (ISO)"),
  createdBy: UuidSchema.nullable().describe("Creator user UUID"),
  createdAt: z.string().describe("Creation timestamp (ISO)"),
  updatedAt: z.string().describe("Last update timestamp (ISO)"),
  lastActivityAt: z.string().optional().describe("Most recent item, comment, or checklist activity timestamp (ISO)"),
  // Optional relations (loaded on demand)
  assignees: z.array(SpaceItemAssigneeSchema).optional().describe("Assigned users"),
  tags: z.array(SpaceTagSchema).optional().describe("Attached tags"),
});
export type SpaceItem = z.infer<typeof SpaceItemSchema>;

export const INACTIVE_ITEM_DAYS = 30;

export const MAX_TASK_CHECKLIST_ENTRIES = 100;
export const SpaceTaskChecklistEntrySchema = z
  .object({
    id: ResourceShortIdSchema.describe("Checklist entry ID"),
    label: z.string().trim().min(1).max(500).describe("Checklist entry label"),
    completed: z.boolean().describe("Whether the checklist entry is complete"),
    createdAt: z.string().datetime().describe("Checklist entry creation timestamp (ISO)"),
    updatedAt: z.string().datetime().describe("Checklist entry update timestamp (ISO)"),
  })
  .strict();
export type SpaceTaskChecklistEntry = z.infer<typeof SpaceTaskChecklistEntrySchema>;

export const CreateTaskChecklistEntrySchema = z.object({ label: z.string().trim().min(1).max(500) }).strict();
export type CreateTaskChecklistEntry = z.infer<typeof CreateTaskChecklistEntrySchema>;

export const UpdateTaskChecklistEntrySchema = z
  .object({
    label: z.string().trim().min(1).max(500).optional(),
    completed: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.label !== undefined || value.completed !== undefined, { message: "At least one checklist field is required" });
export type UpdateTaskChecklistEntry = z.infer<typeof UpdateTaskChecklistEntrySchema>;

export const SpaceTaskDependencyItemSchema = z
  .object({
    id: ResourceShortIdSchema.describe("Blocker task ID"),
    spaceId: ResourceShortIdSchema.describe("Parent Space ID"),
    title: z.string().describe("Blocker task title"),
    completedAt: z.string().nullable().describe("Completion timestamp (ISO)"),
  })
  .strict();
export type SpaceTaskDependencyItem = z.infer<typeof SpaceTaskDependencyItemSchema>;

export const SpaceTaskDependencySchema = z
  .object({
    blocker: SpaceTaskDependencyItemSchema,
    createdAt: z.string().describe("Dependency creation timestamp (ISO)"),
  })
  .strict();
export type SpaceTaskDependency = z.infer<typeof SpaceTaskDependencySchema>;

export const SpaceTaskDependentSchema = z
  .object({
    dependent: SpaceTaskDependencyItemSchema.describe("Task blocked by this task"),
    createdAt: z.string().describe("Dependency creation timestamp (ISO)"),
  })
  .strict();
export type SpaceTaskDependent = z.infer<typeof SpaceTaskDependentSchema>;

export const MAX_ITEM_DEPENDENCIES = 100;
export const SpaceTaskDependencyInputSchema = z
  .object({ blockerItemId: ResourceShortIdSchema.describe("Task that blocks this task") })
  .strict();
export type SpaceTaskDependencyInput = z.infer<typeof SpaceTaskDependencyInputSchema>;

export const MAX_ITEM_RESOURCE_REFERENCES = 100;
export const SpaceItemResourceReferenceInputSchema = z
  .object({
    ref: CloudResourceRefSchema.describe("Stable Cloud resource reference"),
    label: z.string().trim().min(1).max(500).describe("Space-owned display label snapshot"),
  })
  .strict();
export type SpaceItemResourceReferenceInput = z.infer<typeof SpaceItemResourceReferenceInputSchema>;

export const SpaceItemResourceReferenceSchema = SpaceItemResourceReferenceInputSchema.extend({
  createdAt: z.string().datetime().describe("Link creation timestamp (ISO)"),
}).strict();
export type SpaceItemResourceReference = z.infer<typeof SpaceItemResourceReferenceSchema>;

export const MAX_TASK_ATTACHMENTS = 20;
export const MAX_TASK_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
export const SpaceItemAttachmentSchema = z
  .object({
    id: ResourceShortIdSchema.describe("Attachment ID"),
    filename: z.string().min(1).max(255).describe("Original attachment filename"),
    mimeType: z.string().min(1).max(255).describe("Attachment media type"),
    sizeBytes: z.number().int().nonnegative().max(MAX_TASK_ATTACHMENT_SIZE_BYTES).describe("Attachment size in bytes"),
    kind: z.enum(["image", "file"]).describe("Preview category"),
    createdAt: z.string().datetime().describe("Upload timestamp (ISO)"),
  })
  .strict();
export type SpaceItemAttachment = z.infer<typeof SpaceItemAttachmentSchema>;

export const SpaceCommentSchema = z.object({
  id: ResourceShortIdSchema.describe("Comment ID"),
  itemId: ResourceShortIdSchema.describe("Parent item ID"),
  recurrenceId: z.string().datetime().nullable().describe("Recurring occurrence timestamp, or null for an item or entire series"),
  userId: UuidSchema.nullable().describe("Author user UUID"),
  userName: z.string().nullable().describe("Author display name"),
  userAvatarHash: z.string().nullable().describe("Author avatar hash"),
  content: z.string().describe("Comment content"),
  createdAt: z.string().describe("Creation timestamp (ISO)"),
  updatedAt: z.string().describe("Last update timestamp (ISO)"),
  canEdit: z.boolean().describe("Whether the current viewer may edit this comment"),
  canDelete: z.boolean().describe("Whether the current viewer may delete this comment"),
});
export type SpaceComment = z.infer<typeof SpaceCommentSchema>;

// Space with columns and tags (for detail view)
export const SpaceDetailSchema = SpaceSchema.extend({
  columns: z.array(SpaceColumnSchema).describe("Space columns"),
  tags: z.array(SpaceTagSchema).describe("Space tags"),
});
export type SpaceDetail = z.infer<typeof SpaceDetailSchema>;

// Calendar item (for calendar view)
export const CalendarItemSchema = z.object({
  id: z.string().describe("Calendar item ID; recurring instances use a stable virtual ID"),
  spaceId: ResourceShortIdSchema.describe("Parent space ID"),
  spaceName: z.string().describe("Space name"),
  spaceColor: z.string().describe("Space color"),
  title: z.string().describe("Item title"),
  descriptionPreview: z.string().nullable().describe("Plain-text description preview for calendar cards"),
  location: z.string().nullable().describe("Event location"),
  url: z.string().nullable().describe("Event URL"),
  startsAt: z.string().nullable().describe("Event start time (ISO)"),
  endsAt: z.string().nullable().describe("Event end time (ISO)"),
  allDay: z.boolean().default(false).describe("Whether the item is an all-day event"),
  deadline: z.string().nullable().describe("Todo deadline (ISO)"),
  priority: PrioritySchema.nullable().describe("Item priority"),
  recurrence: RecurrenceSchema.nullable().describe("Recurring event series data"),
  recurringEventId: ResourceShortIdSchema.nullable().describe("Parent recurring event ID for overrides"),
  recurrenceId: z.string().nullable().describe("Original occurrence timestamp (ISO) for overrides"),
  isRecurringInstance: z.boolean().optional().describe("Whether this calendar item is an expanded recurring instance"),
  tags: z.array(SpaceTagSchema).optional().describe("Attached tags"),
});
export type CalendarItem = z.infer<typeof CalendarItemSchema>;

// Overlap result
export const OverlapItemSchema = z.object({
  itemId: ResourceShortIdSchema.describe("Overlapping item ID"),
  spaceId: ResourceShortIdSchema.describe("Space ID"),
  spaceName: z.string().describe("Space name"),
  title: z.string().describe("Item title"),
  startsAt: z.string().describe("Event start time (ISO)"),
  endsAt: z.string().describe("Event end time (ISO)"),
});
export type OverlapItem = z.infer<typeof OverlapItemSchema>;

// === Input Schemas ===

export const CreateSpaceSchema = z.object({
  name: z.string().min(1).max(100).describe("Space name"),
  description: z.string().max(500).optional().describe("Space description"),
  starter: z.enum(["blank", "tasks", "calendar", "project"]).optional().describe("Initial workflow template"),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#3b82f6")
    .describe("Space color (hex)"),
});
export type CreateSpace = z.infer<typeof CreateSpaceSchema>;

export const UpdateSpaceSchema = z.object({
  name: z.string().min(1).max(100).optional().describe("Space name"),
  description: z.string().max(500).nullable().optional().describe("Space description"),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .describe("Space color (hex)"),
});
export type UpdateSpace = z.infer<typeof UpdateSpaceSchema>;

export const CreateColumnSchema = z.object({
  name: z.string().min(1).max(50).describe("Column name"),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .describe("Column color (hex)"),
  isDone: z.boolean().default(false).describe("Items in this column are considered done"),
});
export type CreateColumn = z.infer<typeof CreateColumnSchema>;

export const UpdateColumnSchema = z.object({
  name: z.string().min(1).max(50).optional().describe("Column name"),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional()
    .describe("Column color (hex)"),
  isDone: z.boolean().optional().describe("Items in this column are considered done"),
});
export type UpdateColumn = z.infer<typeof UpdateColumnSchema>;

export const ReorderColumnsSchema = z.object({
  columnIds: z.array(ResourceShortIdSchema).max(100).describe("Column IDs in new order"),
});
export type ReorderColumns = z.infer<typeof ReorderColumnsSchema>;

export const CreateTagSchema = z.object({
  name: z.string().min(1).max(30).describe("Tag name"),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .describe("Tag color (hex)"),
});
export type CreateTag = z.infer<typeof CreateTagSchema>;

export const UpdateTagSchema = z.object({
  name: z.string().min(1).max(30).optional().describe("Tag name"),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .describe("Tag color (hex)"),
});
export type UpdateTag = z.infer<typeof UpdateTagSchema>;

export const CreateItemSchema = z
  .object({
    columnId: ResourceShortIdSchema.describe("Target column ID"),
    title: z.string().min(1).max(200).describe("Item title"),
    description: z.string().max(5000).optional().describe("Item description (markdown)"),
    location: z.string().max(500).optional().describe("Event location"),
    url: z.string().url().max(2000).optional().describe("Event URL"),
    startsAt: z.string().datetime().optional().describe("Event start time (ISO)"),
    endsAt: z.string().datetime().optional().describe("Event end time (ISO)"),
    allDay: z.boolean().optional().describe("Whether the item is an all-day event"),
    deadline: z.string().datetime().optional().describe("Todo deadline (ISO)"),
    estimatedDurationMinutes: EstimatedDurationMinutesSchema.optional().describe("Estimated task duration in minutes"),
    priority: PrioritySchema.optional().describe("Item priority"),
    recurrence: RecurrenceSchema.optional().describe("Recurring event series data"),
    recurringEventId: ResourceShortIdSchema.optional().describe("Parent recurring event ID for overrides"),
    recurrenceId: z.string().datetime().optional().describe("Original occurrence timestamp (ISO) for overrides"),
    assigneeIds: z.array(UuidSchema).max(100).optional().describe("Assigned user UUIDs"),
    tagIds: z.array(ResourceShortIdSchema).max(100).optional().describe("Tag IDs"),
    references: z
      .array(SpaceItemResourceReferenceInputSchema)
      .max(MAX_ITEM_RESOURCE_REFERENCES)
      .optional()
      .describe("Cloud resources linked to the item"),
  })
  .refine((data) => !data.startsAt || !data.endsAt || new Date(data.endsAt) > new Date(data.startsAt), {
    message: "End time must be after start time",
    path: ["endsAt"],
  })
  .refine((data) => data.estimatedDurationMinutes === undefined || (!data.startsAt && !data.endsAt), {
    message: "Estimated duration is only available for tasks",
    path: ["estimatedDurationMinutes"],
  });
export type CreateItem = z.infer<typeof CreateItemSchema>;

export const UpdateItemSchema = z
  .object({
    columnId: ResourceShortIdSchema.optional().describe("Target column ID"),
    title: z.string().min(1).max(200).optional().describe("Item title"),
    description: z.string().max(5000).nullable().optional().describe("Item description (markdown)"),
    location: z.string().max(500).nullable().optional().describe("Event location"),
    url: z.string().url().max(2000).nullable().optional().describe("Event URL"),
    startsAt: z.string().datetime().nullable().optional().describe("Event start time (ISO)"),
    endsAt: z.string().datetime().nullable().optional().describe("Event end time (ISO)"),
    allDay: z.boolean().optional().describe("Whether the item is an all-day event"),
    deadline: z.string().datetime().nullable().optional().describe("Todo deadline (ISO)"),
    estimatedDurationMinutes: EstimatedDurationMinutesSchema.nullable().optional().describe("Estimated task duration in minutes"),
    priority: PrioritySchema.nullable().optional().describe("Item priority"),
    recurrence: RecurrenceSchema.nullable().optional().describe("Recurring event series data"),
    recurringEventId: ResourceShortIdSchema.nullable().optional().describe("Parent recurring event ID for overrides"),
    recurrenceId: z.string().datetime().nullable().optional().describe("Original occurrence timestamp (ISO) for overrides"),
    assigneeIds: z.array(UuidSchema).max(100).optional().describe("Assigned user UUIDs"),
    tagIds: z.array(ResourceShortIdSchema).max(100).optional().describe("Tag IDs"),
  })
  .refine((data) => !data.startsAt || !data.endsAt || new Date(data.endsAt) > new Date(data.startsAt), {
    message: "End time must be after start time",
    path: ["endsAt"],
  })
  .refine((data) => data.estimatedDurationMinutes == null || (!data.startsAt && !data.endsAt), {
    message: "Estimated duration is only available for tasks",
    path: ["estimatedDurationMinutes"],
  });
export type UpdateItem = z.infer<typeof UpdateItemSchema>;

export const SplitRecurringItemSchema = z
  .object({
    recurrenceId: z.string().datetime().describe("Original timestamp of the first occurrence in the new series"),
    startsAt: z.string().datetime().describe("New start time for the first occurrence"),
    endsAt: z.string().datetime().describe("New end time for the first occurrence"),
    allDay: z.boolean().describe("Whether the new series is all-day"),
  })
  .refine((data) => new Date(data.endsAt) > new Date(data.startsAt), {
    message: "End time must be after start time",
    path: ["endsAt"],
  });
export type SplitRecurringItem = z.infer<typeof SplitRecurringItemSchema>;

export const MoveItemSchema = z.object({
  columnId: ResourceShortIdSchema.describe("Target column ID"),
  rank: z
    .string()
    .regex(/^-?\d+$/)
    .describe("Target rank value"),
  completed: z.boolean().optional().describe("Optional completion state override after move"),
});
export type MoveItem = z.infer<typeof MoveItemSchema>;

export const CreateWormholeSchema = z.object({
  targetColumnId: ResourceShortIdSchema.describe("Destination column ID"),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#6366f1")
    .describe("Wormhole color (hex)"),
});
export type CreateWormhole = z.infer<typeof CreateWormholeSchema>;

export const UpdateWormholeSchema = z
  .object({
    targetColumnId: ResourceShortIdSchema.optional().describe("Destination column ID"),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional()
      .describe("Wormhole color (hex)"),
  })
  .refine((data) => data.targetColumnId !== undefined || data.color !== undefined, {
    message: "At least one wormhole field must be provided",
  });
export type UpdateWormhole = z.infer<typeof UpdateWormholeSchema>;

export const ReorderWormholesSchema = z.object({
  wormholeIds: z.array(ResourceShortIdSchema).max(100).describe("Wormhole IDs in new order"),
});
export type ReorderWormholes = z.infer<typeof ReorderWormholesSchema>;

export const WormholeTransferResultSchema = z.object({
  item: SpaceItemSchema.describe("Transferred item in its destination space"),
  destination: SpaceWormholeTargetSchema.describe("Resolved destination"),
  removedTagCount: z.number().int().nonnegative().describe("Removed source-space tag count"),
  removedAssigneeCount: z.number().int().nonnegative().describe("Removed assignee count"),
  removedDependencyCount: z.number().int().nonnegative().describe("Removed task dependency count"),
});
export type WormholeTransferResult = z.infer<typeof WormholeTransferResultSchema>;

export const SetCompletedSchema = CompletionInputSchema;
export type SetCompleted = z.infer<typeof SetCompletedSchema>;

export const CreateCommentSchema = z.object({
  content: z.string().min(1).max(5000).describe("Comment content"),
});
export type CreateComment = z.infer<typeof CreateCommentSchema>;

export const UpdateCommentSchema = z.object({
  content: z.string().min(1).max(5000).describe("Comment content"),
});
export type UpdateComment = z.infer<typeof UpdateCommentSchema>;

export const CalendarQuerySchema = z
  .object({
    from: z.string().datetime().describe("Start of date range (ISO)"),
    to: z.string().datetime().describe("End of date range (ISO)"),
  })
  .refine((data) => new Date(data.to) > new Date(data.from), {
    message: "End time must be after start time",
    path: ["to"],
  });
export type CalendarQuery = z.infer<typeof CalendarQuerySchema>;

export const OverlapQuerySchema = z
  .object({
    from: z.string().datetime().describe("Start of time range (ISO)"),
    to: z.string().datetime().describe("End of time range (ISO)"),
    excludeItemId: ResourceShortIdSchema.optional().describe("Item to exclude from check"),
  })
  .refine((data) => new Date(data.to) > new Date(data.from), {
    message: "End time must be after start time",
    path: ["to"],
  });
export type OverlapQuery = z.infer<typeof OverlapQuerySchema>;

// === Item Filter/Sort/Pagination ===

export const ItemTypeSchema = z.enum(["all", "task", "event"]);
export type ItemType = z.infer<typeof ItemTypeSchema>;

export const ItemStatusSchema = z.enum(["active", "completed", "all"]);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

export const ItemActivityFilterSchema = z.enum(["all", "inactive"]);
export type ItemActivityFilter = z.infer<typeof ItemActivityFilterSchema>;

export const DeadlineFilterSchema = z.enum(["all", "overdue", "today", "week", "none"]);
export type DeadlineFilter = z.infer<typeof DeadlineFilterSchema>;

export const ItemSortSchema = z.enum(["column", "priority", "deadline", "created", "updated", "title"]);
export type ItemSort = z.infer<typeof ItemSortSchema>;

export const ItemGroupBySchema = z.enum(["column", "priority", "tag", "deadline", "none"]);
export type ItemGroupBy = z.infer<typeof ItemGroupBySchema>;

export const AssignedToFilterSchema = z.enum(["all", "assigned", "me", "unassigned"]);
export type AssignedToFilter = z.infer<typeof AssignedToFilterSchema>;

export const ItemFilterSchema = z.object({
  // Filter options
  blocked: z.boolean().optional().describe("Whether unfinished blocker tasks exist"),
  type: ItemTypeSchema.default("all").describe("Filter by item type"),
  status: ItemStatusSchema.default("active").describe("Filter by completion status"),
  activity: ItemActivityFilterSchema.default("all").describe("Filter open tasks by recent activity"),
  priority: z.array(PrioritySchema).max(4).optional().describe("Filter by priorities"),
  tagIds: z.array(ResourceShortIdSchema).max(100).optional().describe("Filter by tag IDs"),
  assigneeIds: z.array(UuidSchema).max(100).optional().describe("Filter by assignee IDs"),
  assignedTo: AssignedToFilterSchema.default("all").describe("Filter by assignment: all, me, or unassigned"),
  columnIds: z.array(ResourceShortIdSchema).max(100).optional().describe("Filter by column IDs"),
  deadlineFilter: DeadlineFilterSchema.default("all").describe("Filter by deadline range"),
  search: z.string().optional().describe("Search in title and description"),

  // Sort options
  sort: ItemSortSchema.default("deadline").describe("Sort field"),
  sortDesc: z.boolean().default(false).describe("Sort descending"),

  // Grouping
  groupBy: ItemGroupBySchema.default("deadline").describe("Group items by field"),

  // Pagination
  page: z.number().int().min(1).default(1).describe("Page number (1-indexed)"),
  pageSize: z.number().int().min(1).max(100).default(50).describe("Items per page"),
});
export type ItemFilter = z.infer<typeof ItemFilterSchema>;

export const ItemListResultSchema = z.object({
  items: z.array(SpaceItemSchema).describe("Items matching the filter"),
  total: z.number().int().describe("Total number of matching items"),
  page: z.number().int().describe("Current page"),
  pageSize: z.number().int().describe("Items per page"),
  totalPages: z.number().int().describe("Total number of pages"),
});
export type ItemListResult = z.infer<typeof ItemListResultSchema>;

export type {
  AccessEntry,
  MessageResponse,
  MutationResult,
  PermissionLevel,
  Principal,
  User,
} from "@valentinkolb/cloud/contracts";
export {
  AccessEntrySchema,
  ErrorResponseSchema,
  GrantAccessSchema,
  hasRole,
  MessageResponseSchema,
  PermissionLevelSchema,
  PrincipalSchema,
  UpdateAccessSchema,
} from "@valentinkolb/cloud/contracts";
