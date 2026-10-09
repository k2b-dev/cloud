import { CloudResourceViewSchema } from "@k2b/cloud/contracts";
import { dates as calendar, type DateContext } from "@k2b/stdlib";
import { z } from "zod";
import {
  CalendarItemSchema,
  ItemListResultSchema,
  MAX_ITEM_LINKS,
  ResourceShortIdSchema,
  SpaceCommentSchema,
  SpaceDetailSchema,
  SpaceItemAttachmentSchema,
  SpaceItemLinkSchema,
  SpaceItemResourceReferenceSchema,
  SpaceItemSchema,
  SpaceTaskChecklistEntrySchema,
  SpaceTaskDependencySchema,
  SpaceTaskDependentSchema,
  SpaceVirtualColumnKindSchema,
  SpaceWormholeSchema,
} from "@/contracts";
import { SpaceUserSettingsSchema } from "@/settings-context";
import { TaskWorkSchema } from "../../../../work-contracts";
import { type CalendarFilter, CalendarFilterSchema, writeCalendarFilter } from "../calendar/filter";
import { TASK_TRAY_SIZE } from "../calendar/tray";
import { boardFilter, buildFilterUrl, type parseFilterFromUrl, QueryParams } from "../filter/types";

type FilterState = ReturnType<typeof parseFilterFromUrl>;

const WorkspaceNotFoundSchema = z.object({ kind: z.literal("notFound"), title: z.string(), message: z.string() });
const WorkspaceAccessDeniedSchema = z.object({
  kind: z.literal("accessDenied"),
  title: z.string(),
  message: z.string(),
  redirectTo: z.string().optional(),
});

const WorkspaceTitleSchema = z.array(z.object({ title: z.string(), href: z.string().optional() }));
const CalendarViewSchema = z.enum(["day", "week", "month", "year"]);
const DayWeatherSchema = z.object({ tempMin: z.number(), tempMax: z.number(), icon: z.string() });
/** One part of the tray below the day view: its first tasks and how many it holds in all. */
const CalendarTrayListSchema = z.object({
  items: z.array(SpaceItemSchema).max(TASK_TRAY_SIZE),
  total: z.number().int().nonnegative(),
});
/** Tasks a day has no place for; null outside the day view and while the calendar shows only events. */
const CalendarTraySchema = z.object({ overdue: CalendarTrayListSchema, undated: CalendarTrayListSchema }).nullable();
export type CalendarTray = NonNullable<z.infer<typeof CalendarTraySchema>>;

const KanbanBucketInitialSchema = z.object({
  key: z.string(),
  label: z.string(),
  color: z.string().nullable(),
  kind: z.union([z.literal("column"), SpaceVirtualColumnKindSchema]),
  columnId: z.string().nullable(),
  isDone: z.boolean(),
  items: z.array(SpaceItemSchema),
  page: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  unfilteredTotal: z.number().int().nonnegative().optional(),
});

export const SpaceCommentPageSchema = z.object({
  items: z.array(SpaceCommentSchema),
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  hasNext: z.boolean(),
});

export const SpaceItemRecurringContextSchema = z.object({
  seriesItemId: ResourceShortIdSchema,
  recurrenceId: z.string().datetime(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  allDay: z.boolean(),
  isOverride: z.boolean(),
});

export const SpaceItemDetailSchema = z.object({
  work: TaskWorkSchema.optional(),
  item: SpaceItemSchema,
  comments: SpaceCommentPageSchema,
  commentTarget: z.object({
    itemId: ResourceShortIdSchema,
    recurrenceId: z.string().datetime().nullable(),
  }),
  recurringContext: SpaceItemRecurringContextSchema.nullable(),
  references: z.array(SpaceItemResourceReferenceSchema.extend({ resource: CloudResourceViewSchema.nullable() })).max(100),
  links: z.array(SpaceItemLinkSchema).max(MAX_ITEM_LINKS),
  attachments: z.array(SpaceItemAttachmentSchema).max(20),
  checklist: z.array(SpaceTaskChecklistEntrySchema).max(100),
  blockedBy: z.array(SpaceTaskDependencySchema).max(100),
  blocks: z.array(SpaceTaskDependentSchema).max(100),
});
export type SpaceItemDetail = z.infer<typeof SpaceItemDetailSchema>;

export const SpacesViewSnapshotSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list"), currentView: z.enum(["list", "table"]), itemsResult: ItemListResultSchema }),
  z.object({ kind: z.literal("kanban"), buckets: z.array(KanbanBucketInitialSchema), wormholes: z.array(SpaceWormholeSchema) }),
  z.object({
    kind: z.literal("calendar"),
    view: CalendarViewSchema,
    date: z.string().datetime(),
    filter: CalendarFilterSchema,
    items: z.array(CalendarItemSchema),
    weather: z.record(z.string(), DayWeatherSchema),
    tray: CalendarTraySchema,
  }),
]);
export type SpacesViewSnapshot = z.infer<typeof SpacesViewSnapshotSchema>;

const SpacesWorkspaceStateSchema = z.discriminatedUnion("kind", [
  WorkspaceNotFoundSchema,
  WorkspaceAccessDeniedSchema,
  z.object({
    kind: z.literal("ok"),
    title: WorkspaceTitleSchema,
    currentUserId: z.string(),
    space: SpaceDetailSchema,
    settings: SpaceUserSettingsSchema,
    currentView: z.enum(["list", "table", "kanban", "calendar"]),
    hasOverride: z.boolean(),
    isAdmin: z.boolean(),
    canWrite: z.boolean(),
    query: z.string(),
    icalBaseUrl: z.string(),
    eventCursor: z.string().nullable(),
    /** The day, in the person's time zone, that deadline views in this snapshot were computed for. */
    snapshotDay: z.string(),
    itemsResult: ItemListResultSchema,
    kanbanBuckets: z.array(KanbanBucketInitialSchema),
    calendarView: CalendarViewSchema,
    calendarDate: z.string().datetime(),
    calendarFilter: CalendarFilterSchema,
    calendarItems: z.array(CalendarItemSchema),
    calendarWeather: z.record(z.string(), DayWeatherSchema),
    calendarTray: CalendarTraySchema,
    selectedItemDetail: SpaceItemDetailSchema.nullable(),
    wormholes: z.array(SpaceWormholeSchema),
  }),
]);
export type SpacesWorkspaceState = z.infer<typeof SpacesWorkspaceStateSchema>;

export const parseSpacesWorkspaceHref = (href: string) => {
  const url = new URL(href, "http://spaces.local");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "app" || parts[1] !== "spaces" || !parts[2] || !ResourceShortIdSchema.safeParse(parts[2]).success) return null;
  return parts.length === 3 ? { spaceId: parts[2] } : null;
};

const withViewOverrides = (params: { baseUrl: string; hasViewOverride: boolean; currentView: string }) => {
  const url = new URL(params.baseUrl, "http://localhost");
  if (params.hasViewOverride) url.searchParams.set("view", params.currentView);
  const query = url.searchParams.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
};

const withoutSelectedItem = (href: string) => {
  const url = new URL(href, "http://localhost");
  url.searchParams.delete(QueryParams.ITEM);
  url.searchParams.delete(QueryParams.OCCURRENCE);
  const query = url.searchParams.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
};

export const buildSpacesPaginationBaseUrl = (params: {
  baseSpaceUrl: string;
  filter: FilterState;
  hasViewOverride: boolean;
  currentView: string;
}) =>
  withViewOverrides({
    baseUrl: buildFilterUrl(params.baseSpaceUrl, { page: 0 }, params.filter),
    hasViewOverride: params.hasViewOverride,
    currentView: params.currentView,
  }).replace("page=0", "page=");

export const buildSpacesItemLinkBaseUrl = (params: {
  baseSpaceUrl: string;
  currentView: string;
  filter: FilterState;
  hasViewOverride: boolean;
  calendarView?: string;
  calendarDate?: string;
  calendarFilter?: CalendarFilter;
  dateConfig?: DateContext;
}) =>
  withoutSelectedItem(
    withViewOverrides({
      baseUrl:
        params.currentView === "list" || params.currentView === "table"
          ? buildFilterUrl(params.baseSpaceUrl, {}, params.filter)
          : params.currentView === "kanban"
            ? buildFilterUrl(params.baseSpaceUrl, {}, boardFilter(params.filter))
            : buildCalendarUrl(params.baseSpaceUrl, params),
      hasViewOverride: params.hasViewOverride,
      currentView: params.currentView,
    }),
  );

const buildCalendarUrl = (
  baseSpaceUrl: string,
  params: {
    currentView: string;
    calendarView?: string;
    calendarDate?: string;
    calendarFilter?: CalendarFilter;
    dateConfig?: DateContext;
  },
) => {
  if (params.currentView !== "calendar") return baseSpaceUrl;
  const url = new URL(baseSpaceUrl, "http://localhost");
  if (params.calendarView) url.searchParams.set("cv", params.calendarView);
  if (params.calendarDate) url.searchParams.set("cd", calendar.formatDateKey(params.calendarDate, params.dateConfig));
  if (params.calendarFilter) writeCalendarFilter(url, params.calendarFilter);
  const query = url.searchParams.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
};
