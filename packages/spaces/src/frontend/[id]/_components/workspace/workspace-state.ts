import { dates as calendar, type DateContext } from "@k2b/stdlib";
import { logger, weatherService } from "@valentinkolb/cloud/services";
import {
  type CalendarItem,
  type ItemListResult,
  ResourceShortIdSchema,
  type SpaceDetail,
  type SpaceItem,
  type SpaceWormhole,
  type User,
} from "@/contracts";
import { spacesService } from "@/service";
import { latestSpaceEventCursor } from "@/service/events";
import { spacesPublicResources } from "@/service/public-resources";
import { resolveRecurringOccurrence } from "@/service/recurrence";
import { resolveReferenceViews } from "@/service/resource-reference-views";
import { spaceMessages } from "../../messages";
import { type CalendarFilter, parseCalendarFilter } from "../calendar/filter";
import type { CalendarView, DayWeather } from "../calendar/types";
import { defaultFilter, type FilterState, parseFilterFromUrl } from "../filter/types";
import type { KanbanBucketInitial } from "../kanban/types";
import { isValidView, parseSpaceSettings, type SpaceUserSettings, type ViewType } from "../settings/SpaceSettingsStore";
import type { SpaceItemDetail, SpacesViewSnapshot, SpacesWorkspaceState } from "./workspace-types";

type AuthUser = Pick<User, "id" | "roles">;

const log = logger("spaces:workspace-state");

type WorkspaceRequest = {
  user: AuthUser;
  /** Internal UUID resolved once by the route or API boundary. */
  spaceId: string;
  /** Canonical public ID used by URLs, cookies, and serialized state. */
  spaceShortId: string;
  href: string;
  cookieHeader?: string;
  authorizationHeader?: string;
  dateConfig?: DateContext;
};

type RouteState = {
  url: URL;
  settings: SpaceUserSettings;
  currentView: ViewType;
  hasOverride: boolean;
  filter: FilterState;
  selectedItemId: string;
  selectedOccurrenceId: string | null;
  calendarViewParam: CalendarView | null;
  calendarDateParam?: string;
  calendarFilter: CalendarFilter;
};

const LIST_PAGE_SIZE = 50;
const KANBAN_PAGE_SIZE = 30;
const CALENDAR_VIEWS: CalendarView[] = ["day", "week", "month", "year"];
const COMMENT_PAGE_SIZE = 50;
const WEATHER_FORECAST_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const resolveView = (url: URL, settings: SpaceUserSettings) => {
  const viewParam = url.searchParams.get("view") ?? undefined;
  const hasViewOverride = isValidView(viewParam);
  return { currentView: hasViewOverride ? viewParam : settings.view, hasViewOverride };
};

const resolveRouteState = (params: WorkspaceRequest): RouteState => {
  const url = new URL(params.href, "http://spaces.local");
  const settings = parseSpaceSettings(params.cookieHeader, params.spaceShortId);
  const { currentView, hasViewOverride } = resolveView(url, settings);

  return {
    url,
    settings,
    currentView,
    hasOverride: hasViewOverride,
    filter: currentView === "list" || currentView === "table" ? parseFilterFromUrl(url) : defaultFilter,
    selectedItemId: url.searchParams.get("item") ?? "",
    selectedOccurrenceId: url.searchParams.get("occurrence"),
    calendarViewParam: url.searchParams.get("cv") as CalendarView | null,
    calendarDateParam: url.searchParams.get("cd") ?? undefined,
    calendarFilter: parseCalendarFilter(url),
  };
};

const resolvePermissions = async (params: { spaceId: string; user: AuthUser }) => {
  const userPermission = await spacesService.space.permission.get({
    spaceId: params.spaceId,
    subject: { type: "user", userId: params.user.id },
  });
  if (userPermission === "none") return null;

  return {
    isAdmin: userPermission === "admin",
    canWrite: userPermission === "write" || userPermission === "admin",
  };
};

const nonEmpty = <T>(values: T[]) => (values.length > 0 ? values : undefined);

const projectSpaceDetail = async (space: SpaceDetail): Promise<SpaceDetail> => {
  const [[projectedSpace], columns, tags] = await Promise.all([
    spacesPublicResources.projectSpaces([space]),
    spacesPublicResources.projectColumns(space.columns),
    spacesPublicResources.projectTags(space.tags),
  ]);
  if (!projectedSpace) throw new Error("Missing public ID for Space");
  return { ...projectedSpace, columns, tags };
};

const projectItemResult = async (result: ItemListResult): Promise<ItemListResult> => ({
  ...result,
  items: await spacesPublicResources.projectItems(result.items),
});

const projectItemDetail = async (
  detail: Omit<SpaceItemDetail, "references" | "attachments" | "checklist" | "blockedBy" | "blocks"> & {
    references?: SpaceItemDetail["references"];
    attachments?: SpaceItemDetail["attachments"];
    checklist?: SpaceItemDetail["checklist"];
    blockedBy?: SpaceItemDetail["blockedBy"];
    blocks?: SpaceItemDetail["blocks"];
  },
): Promise<SpaceItemDetail> => {
  const [[item], comments, blockedBy, blocks] = await Promise.all([
    spacesPublicResources.projectItems([detail.item]),
    spacesPublicResources.projectComments(detail.comments.items),
    spacesPublicResources.projectTaskDependencies(detail.blockedBy ?? []),
    spacesPublicResources.projectTaskDependents(detail.blocks ?? []),
  ]);
  if (!item) throw new Error("Missing public ID for Space item");
  const seriesItemId = item.recurringEventId ?? item.id;
  return {
    item,
    work: detail.work,
    comments: { ...detail.comments, items: comments },
    commentTarget: { ...detail.commentTarget, itemId: seriesItemId },
    recurringContext: detail.recurringContext ? { ...detail.recurringContext, seriesItemId } : null,
    references: detail.references ?? [],
    attachments: detail.attachments ?? [],
    checklist: detail.checklist ?? [],
    blockedBy,
    blocks,
  };
};

const projectKanbanBuckets = async (buckets: KanbanBucketInitial[], columnIds: Map<string, string>): Promise<KanbanBucketInitial[]> => {
  const internalItems = buckets.flatMap((bucket) => bucket.items);
  const items = await spacesPublicResources.projectItems(internalItems);
  let offset = 0;
  return buckets.map((bucket) => {
    const projectedItems = items.slice(offset, offset + bucket.items.length);
    offset += bucket.items.length;
    const columnId = bucket.columnId ? columnIds.get(bucket.columnId) : null;
    if (bucket.columnId && !columnId) throw new Error(`Missing public ID for Space column ${bucket.columnId}`);
    return {
      ...bucket,
      key: columnId ? `column:${columnId}` : bucket.key,
      columnId: columnId ?? null,
      items: projectedItems,
    };
  });
};

const toListFilter = (filter: FilterState) => ({
  type: filter.type,
  status: filter.status,
  activity: filter.activity,
  priority: nonEmpty(filter.priority),
  tagIds: nonEmpty(filter.tagIds),
  columnIds: nonEmpty(filter.columnIds),
  assignedTo: filter.assignedTo,
  deadlineFilter: filter.deadlineFilter,
  search: filter.search || undefined,
  sort: filter.sort,
  sortDesc: filter.sortDesc,
  groupBy: filter.groupBy,
  page: filter.page,
  pageSize: LIST_PAGE_SIZE,
});

const loadListItems = async (params: {
  currentView: ViewType;
  spaceId: string;
  filter: FilterState;
  userId: string;
  dateConfig?: DateContext;
}): Promise<ItemListResult> => {
  if (params.currentView !== "list" && params.currentView !== "table") {
    return { items: [], total: 0, page: params.filter.page, pageSize: LIST_PAGE_SIZE, totalPages: 0 };
  }

  return spacesService.item.listFiltered({
    spaceId: params.spaceId,
    filter: toListFilter(params.filter),
    currentUserId: params.userId,
    dateConfig: params.dateConfig,
  });
};

const loadKanbanBuckets = async (params: {
  currentView: ViewType;
  space: SpaceDetail;
  spaceId: string;
  userId: string;
  dateConfig?: DateContext;
}): Promise<KanbanBucketInitial[]> => {
  if (params.currentView !== "kanban") return [];

  const loadBucket = async (config: {
    key: string;
    label: string;
    color: string | null;
    kind: "column";
    columnId: string | null;
    isDone: boolean;
    columnIds?: string[];
  }): Promise<KanbanBucketInitial> => {
    const result = await spacesService.item.listFiltered({
      spaceId: params.spaceId,
      filter: {
        type: "all",
        status: config.isDone ? "completed" : "active",
        activity: "all",
        priority: undefined,
        tagIds: undefined,
        columnIds: config.columnIds && config.columnIds.length > 0 ? config.columnIds : undefined,
        assignedTo: "all",
        deadlineFilter: "all",
        search: undefined,
        sort: "column",
        sortDesc: false,
        groupBy: "column",
        page: 1,
        pageSize: KANBAN_PAGE_SIZE,
      },
      currentUserId: params.userId,
      dateConfig: params.dateConfig,
    });
    return { ...config, items: result.items, page: result.page, totalPages: result.totalPages, total: result.total };
  };

  return Promise.all(
    params.space.columns.map((column) =>
      loadBucket({
        key: `column:${column.id}`,
        label: column.name,
        color: column.color,
        kind: "column",
        columnId: column.id,
        isDone: column.isDone,
        columnIds: [column.id],
      }),
    ),
  );
};

const resolveCalendarRange = (params: { calendarView: CalendarView; calendarDate: Date; dateConfig?: DateContext }) => {
  const calendarYear = Number(calendar.formatDateKey(params.calendarDate, params.dateConfig).slice(0, 4));
  if (params.calendarView === "day") return { from: params.calendarDate, to: calendar.addDays(params.calendarDate, 1, params.dateConfig) };
  if (params.calendarView !== "year") return calendar.getDateRange(params.calendarView, params.calendarDate, params.dateConfig);

  if (!params.dateConfig?.timeZone) return { from: new Date(calendarYear, 0, 1), to: new Date(calendarYear + 1, 0, 1) };
  return {
    from: new Date(
      calendar.zonedDateTimeToInstant(`${calendarYear}-01-01T00:00`, params.dateConfig.timeZone, { disambiguation: "compatible" }),
    ),
    to: new Date(
      calendar.zonedDateTimeToInstant(`${calendarYear + 1}-01-01T00:00`, params.dateConfig.timeZone, { disambiguation: "compatible" }),
    ),
  };
};

const readWeatherLocationCookie = (cookieHeader?: string) => {
  const locationCookie = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${weatherService.location.cookie.name}=`))
    ?.slice(weatherService.location.cookie.name.length + 1);
  return weatherService.location.cookie.parse(locationCookie);
};

const resolveCalendarView = (view: CalendarView | null): CalendarView => (view && CALENDAR_VIEWS.includes(view) ? view : "month");

const overlapsWeatherForecast = (from: Date, to: Date, now = new Date()) => {
  const forecastFrom = new Date(now);
  forecastFrom.setUTCHours(0, 0, 0, 0);
  const forecastTo = new Date(forecastFrom.getTime() + WEATHER_FORECAST_DAYS * DAY_MS);
  return from < forecastTo && to > forecastFrom;
};

const loadCalendarWeather = async (params: { cookieHeader?: string; from: Date; to: Date }): Promise<Record<string, DayWeather>> => {
  // Brightsky only returns the next seven days; remote ranges must not pay for external I/O they cannot display.
  if (!overlapsWeatherForecast(params.from, params.to)) return {};

  const location = readWeatherLocationCookie(params.cookieHeader);
  const weatherData = await weatherService.forecast.get({ lat: location?.lat, lon: location?.lon });
  const weather: Record<string, DayWeather> = {};
  if (!weatherData?.daily) return weather;

  for (const day of weatherData.daily) {
    weather[day.date] = {
      tempMin: day.tempMin,
      tempMax: day.tempMax,
      icon: weatherService.ui.getTablerIcon(day.icon),
    };
  }
  return weather;
};

const loadCalendarState = async (params: {
  currentView: ViewType;
  calendarViewParam: CalendarView | null;
  calendarDateParam?: string;
  calendarFilter: CalendarFilter;
  spaceId: string;
  user: AuthUser;
  dateConfig?: DateContext;
  cookieHeader?: string;
}): Promise<{
  calendarView: CalendarView;
  calendarDate: Date;
  calendarItems: CalendarItem[];
  calendarWeather: Record<string, DayWeather>;
}> => {
  const calendarView = resolveCalendarView(params.calendarViewParam);
  const calendarDate = calendar.parseCalendarDate(params.calendarDateParam, params.dateConfig);
  if (params.currentView !== "calendar") return { calendarView, calendarDate, calendarItems: [], calendarWeather: {} };

  const { from, to } = resolveCalendarRange({ calendarView, calendarDate, dateConfig: params.dateConfig });
  const [accessibleItems, calendarWeather] = await Promise.all([
    spacesService.item.calendar.list({
      subject: { type: "user", userId: params.user.id },
      spaceId: params.spaceId,
      type: params.calendarFilter.type,
      assignedTo: params.calendarFilter.assignedTo,
      priorities: params.calendarFilter.priorities,
      columnIds: params.calendarFilter.columnIds,
      tagIds: params.calendarFilter.tagIds,
      from: from.toISOString(),
      to: to.toISOString(),
      dateConfig: params.dateConfig,
    }),
    loadCalendarWeather({ cookieHeader: params.cookieHeader, from, to }),
  ]);

  return {
    calendarView,
    calendarDate,
    calendarItems: accessibleItems,
    calendarWeather,
  };
};

const resolveRecurringDetail = async (params: {
  item: SpaceItem;
  occurrenceId: string;
  spaceId: string;
  dateConfig?: DateContext;
}): Promise<{ item: SpaceItem; context: NonNullable<SpaceItemDetail["recurringContext"]> } | null> => {
  const occurrenceDate = new Date(params.occurrenceId);
  if (Number.isNaN(occurrenceDate.getTime())) return null;
  const recurrenceId = occurrenceDate.toISOString();

  if (params.item.recurringEventId) {
    if (params.item.recurrenceId !== recurrenceId || !params.item.startsAt || !params.item.endsAt) return null;
    const series = await spacesService.item.get({ id: params.item.recurringEventId });
    if (!series || series.spaceId !== params.spaceId || !series.recurrence || !series.startsAt || !series.endsAt) return null;
    const occurrence = resolveRecurringOccurrence({
      event: {
        id: series.id,
        title: series.title,
        start: series.startsAt,
        end: series.endsAt,
        allDay: series.allDay,
        recurrence: {
          rrule: series.recurrence.rrule,
          dtstart: series.recurrence.dtstart ?? series.startsAt,
          exdate: series.recurrence.exdate,
        },
      },
      recurrenceId,
      dateConfig: params.dateConfig,
    });
    if (!occurrence) return null;
    return {
      item: params.item,
      context: {
        seriesItemId: series.id,
        recurrenceId,
        startsAt: params.item.startsAt,
        endsAt: params.item.endsAt,
        allDay: params.item.allDay,
        isOverride: true,
      },
    };
  }

  if (!params.item.recurrence || !params.item.startsAt || !params.item.endsAt) return null;
  const occurrence = resolveRecurringOccurrence({
    event: {
      id: params.item.id,
      title: params.item.title,
      start: params.item.startsAt,
      end: params.item.endsAt,
      allDay: params.item.allDay,
      recurrence: {
        rrule: params.item.recurrence.rrule,
        dtstart: params.item.recurrence.dtstart ?? params.item.startsAt,
        exdate: params.item.recurrence.exdate,
      },
    },
    recurrenceId,
    dateConfig: params.dateConfig,
  });
  if (!occurrence) return null;

  const override = await spacesService.item.getRecurringOverride({
    recurringEventId: params.item.id,
    recurrenceId,
  });
  if (override) {
    if (override.spaceId !== params.spaceId || !override.startsAt || !override.endsAt) return null;
    return {
      item: override,
      context: {
        seriesItemId: params.item.id,
        recurrenceId,
        startsAt: override.startsAt,
        endsAt: override.endsAt,
        allDay: override.allDay,
        isOverride: true,
      },
    };
  }

  return {
    item: params.item,
    context: {
      seriesItemId: params.item.id,
      recurrenceId,
      startsAt: occurrence.start,
      endsAt: occurrence.end,
      allDay: occurrence.allDay,
      isOverride: false,
    },
  };
};

const loadSelectedItemState = async (params: {
  selectedItemId: string;
  selectedOccurrenceId: string | null;
  itemsResult: ItemListResult;
  spaceId: string;
  userId: string;
  dateConfig?: DateContext;
  cookieHeader?: string;
  authorizationHeader?: string;
}): Promise<SpaceItemDetail | null> => {
  if (!ResourceShortIdSchema.safeParse(params.selectedItemId).success) return null;
  const selectedItemId = await spacesPublicResources.resolvePublicId("items", params.selectedItemId);
  if (!selectedItemId) return null;

  let selectedItem = params.itemsResult.items.find((item) => item.id === selectedItemId) ?? null;
  if (!selectedItem) {
    selectedItem = await spacesService.item.get({ id: selectedItemId });
    if (selectedItem?.spaceId !== params.spaceId) selectedItem = null;
  }
  if (!selectedItem) return null;

  const recurringDetail = params.selectedOccurrenceId
    ? await resolveRecurringDetail({
        item: selectedItem,
        occurrenceId: params.selectedOccurrenceId,
        spaceId: params.spaceId,
        dateConfig: params.dateConfig,
      })
    : null;
  if (params.selectedOccurrenceId && !recurringDetail) return null;
  const detailItem = recurringDetail?.item ?? selectedItem;
  const recurringContext = recurringDetail?.context ?? null;

  const commentTarget = {
    itemId: recurringContext?.seriesItemId ?? detailItem.id,
    recurrenceId: recurringContext?.recurrenceId ?? null,
  };
  const comments = await spacesService.comment.list({
    itemId: commentTarget.itemId,
    recurrenceId: commentTarget.recurrenceId,
    viewerUserId: params.userId,
    pagination: { page: 1, perPage: COMMENT_PAGE_SIZE },
  });

  const [work, references, attachments, checklist, blockedBy, blocks] = await Promise.all([
    detailItem.startsAt || detailItem.endsAt ? Promise.resolve(undefined) : spacesService.item.work.read(detailItem.id),
    spacesService.item.references.list({ itemId: detailItem.id }),
    detailItem.startsAt || detailItem.endsAt ? Promise.resolve([]) : spacesService.item.attachments.list({ itemId: detailItem.id }),
    detailItem.startsAt || detailItem.endsAt ? Promise.resolve([]) : spacesService.item.checklist.list({ itemId: detailItem.id }),
    spacesService.item.dependencies.list({ itemId: detailItem.id }),
    spacesService.item.dependencies.listBlocks({ blockerItemId: detailItem.id }),
  ]);
  return projectItemDetail({
    item: detailItem,
    work,
    comments,
    commentTarget,
    recurringContext,
    references: await resolveReferenceViews(references, {
      cookie: params.cookieHeader,
      authorization: params.authorizationHeader,
    }),
    attachments,
    checklist,
    blockedBy,
    blocks,
  });
};

const loadWormholes = async (params: { canWrite: boolean; spaceId: string; user: AuthUser }): Promise<SpaceWormhole[]> => {
  if (!params.canWrite) return [];
  const actor = spacesService.wormhole.actorForUser(params.user);
  return spacesService.wormhole.listUsable({ sourceSpaceId: params.spaceId, actor });
};

const loadWorkspaceData = async (params: {
  route: RouteState;
  space: SpaceDetail;
  permissions: { isAdmin: boolean; canWrite: boolean };
  request: WorkspaceRequest;
  calendarFilter: CalendarFilter;
}) => {
  const [wormholes, itemsResult, kanbanBuckets, calendarState] = await Promise.all([
    loadWormholes({
      canWrite: params.permissions.canWrite,
      spaceId: params.request.spaceId,
      user: params.request.user,
    }),
    loadListItems({
      currentView: params.route.currentView,
      spaceId: params.request.spaceId,
      filter: params.route.filter,
      userId: params.request.user.id,
      dateConfig: params.request.dateConfig,
    }),
    loadKanbanBuckets({
      currentView: params.route.currentView,
      space: params.space,
      spaceId: params.request.spaceId,
      userId: params.request.user.id,
      dateConfig: params.request.dateConfig,
    }),
    loadCalendarState({
      currentView: params.route.currentView,
      calendarViewParam: params.route.calendarViewParam,
      calendarDateParam: params.route.calendarDateParam,
      calendarFilter: params.calendarFilter,
      spaceId: params.request.spaceId,
      user: params.request.user,
      dateConfig: params.request.dateConfig,
      cookieHeader: params.request.cookieHeader,
    }),
  ]);

  return { wormholes, itemsResult, kanbanBuckets, calendarState };
};

const buildWorkspaceTitle = (space: SpaceDetail, locale?: string): Array<{ title: string; href?: string }> => [
  { title: spaceMessages.resolve(locale ? [locale] : []).t.start, href: "/" },
  { title: "Spaces", href: "/app/spaces" },
  { title: space.name, href: `/app/spaces/${space.id}` },
];

const loadEventCursor = async (spaceId: string): Promise<string | null> => {
  try {
    return await latestSpaceEventCursor(spaceId);
  } catch (error) {
    log.warn("Could not capture workspace event cursor", {
      spaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

type WorkspaceError = Extract<SpacesWorkspaceState, { kind: "notFound" | "accessDenied" }>;
type AuthorizedWorkspaceContext = {
  route: RouteState;
  permissions: { isAdmin: boolean; canWrite: boolean };
};
type WorkspaceContext = {
  route: RouteState;
  space: SpaceDetail;
  publicSpace: SpaceDetail;
  permissions: { isAdmin: boolean; canWrite: boolean };
  calendarFilter: CalendarFilter;
  publicCalendarFilter: CalendarFilter;
  columnIds: Map<string, string>;
};

const authorizeWorkspace = async (
  params: WorkspaceRequest,
): Promise<{ ok: true; value: AuthorizedWorkspaceContext } | { ok: false; error: WorkspaceError }> => {
  const { t } = spaceMessages.resolve(params.dateConfig?.locale ? [params.dateConfig.locale] : []);
  const route = resolveRouteState(params);
  const [existingSpace, permissions] = await Promise.all([
    spacesService.space.get({ id: params.spaceId }),
    resolvePermissions({ spaceId: params.spaceId, user: params.user }),
  ]);
  if (!existingSpace) return { ok: false, error: { kind: "notFound", title: t.notFound, message: t.spaceNotFound } };
  if (!permissions) {
    return { ok: false, error: { kind: "accessDenied", title: t.accessDenied, message: t.spaceAccessDenied } };
  }
  return { ok: true, value: { route, permissions } };
};

const loadWorkspaceContext = async (
  params: WorkspaceRequest,
  authorized?: AuthorizedWorkspaceContext,
): Promise<{ ok: true; value: WorkspaceContext } | { ok: false; error: WorkspaceError }> => {
  const { t } = spaceMessages.resolve(params.dateConfig?.locale ? [params.dateConfig.locale] : []);
  const access = authorized ? { ok: true as const, value: authorized } : await authorizeWorkspace(params);
  if (!access.ok) return access;

  const space = await spacesService.space.getDetail({ id: params.spaceId });
  if (!space) return { ok: false, error: { kind: "notFound", title: t.notFound, message: t.spaceNotFound } };
  const publicSpace = await projectSpaceDetail(space);
  const tagIds = new Map(publicSpace.tags.map((tag, index) => [tag.id, space.tags[index]!.id]));
  const columnIdsByPublicId = new Map(publicSpace.columns.map((column, index) => [column.id, space.columns[index]!.id]));
  const columnIds = new Map(space.columns.map((column, index) => [column.id, publicSpace.columns[index]!.id]));
  const publicCalendarFilter = {
    ...access.value.route.calendarFilter,
    tagIds: access.value.route.calendarFilter.tagIds.filter((id) => tagIds.has(id)),
    columnIds: access.value.route.calendarFilter.columnIds.filter((id) => columnIdsByPublicId.has(id)),
  };
  const calendarFilter = {
    ...publicCalendarFilter,
    tagIds: publicCalendarFilter.tagIds.map((id) => tagIds.get(id)!),
    columnIds: publicCalendarFilter.columnIds.map((id) => columnIdsByPublicId.get(id)!),
  };
  const route = {
    ...access.value.route,
    filter: {
      ...access.value.route.filter,
      tagIds: access.value.route.filter.tagIds.flatMap((id) => (tagIds.has(id) ? [tagIds.get(id)!] : [])),
      columnIds: access.value.route.filter.columnIds.flatMap((id) => (columnIdsByPublicId.has(id) ? [columnIdsByPublicId.get(id)!] : [])),
    },
  };
  return {
    ok: true,
    value: { ...access.value, route, space, publicSpace, calendarFilter, publicCalendarFilter, columnIds },
  };
};

const toViewSnapshot = async (params: {
  route: RouteState;
  itemsResult: ItemListResult;
  kanbanBuckets: KanbanBucketInitial[];
  wormholes: SpaceWormhole[];
  calendarState: Awaited<ReturnType<typeof loadCalendarState>>;
  publicCalendarFilter: CalendarFilter;
  columnIds: Map<string, string>;
}): Promise<SpacesViewSnapshot> => {
  if (params.route.currentView === "list" || params.route.currentView === "table") {
    return { kind: "list", currentView: params.route.currentView, itemsResult: await projectItemResult(params.itemsResult) };
  }
  if (params.route.currentView === "kanban") {
    const [buckets, wormholes] = await Promise.all([
      projectKanbanBuckets(params.kanbanBuckets, params.columnIds),
      spacesPublicResources.projectWormholes(params.wormholes),
    ]);
    return { kind: "kanban", buckets, wormholes };
  }
  return {
    kind: "calendar",
    view: params.calendarState.calendarView,
    date: params.calendarState.calendarDate.toISOString(),
    filter: params.publicCalendarFilter,
    items: await spacesPublicResources.projectCalendarItems(params.calendarState.calendarItems),
    weather: params.calendarState.calendarWeather,
  };
};

export const loadSpacesViewSnapshot = async (
  params: WorkspaceRequest,
): Promise<SpacesViewSnapshot | Extract<SpacesWorkspaceState, { kind: "notFound" | "accessDenied" }>> => {
  const context = await loadWorkspaceContext(params);
  if (!context.ok) return context.error;
  const { route, space, permissions, calendarFilter, publicCalendarFilter, columnIds } = context.value;

  const [itemsResult, kanbanBuckets, calendarState, wormholes] = await Promise.all([
    loadListItems({
      currentView: route.currentView,
      spaceId: params.spaceId,
      filter: route.filter,
      userId: params.user.id,
      dateConfig: params.dateConfig,
    }),
    loadKanbanBuckets({
      currentView: route.currentView,
      space,
      spaceId: params.spaceId,
      userId: params.user.id,
      dateConfig: params.dateConfig,
    }),
    loadCalendarState({
      currentView: route.currentView,
      calendarViewParam: route.calendarViewParam,
      calendarDateParam: route.calendarDateParam,
      calendarFilter,
      spaceId: params.spaceId,
      user: params.user,
      dateConfig: params.dateConfig,
      cookieHeader: params.cookieHeader,
    }),
    route.currentView === "kanban"
      ? loadWormholes({
          canWrite: permissions.canWrite,
          spaceId: params.spaceId,
          user: params.user,
        })
      : Promise.resolve([]),
  ]);
  return toViewSnapshot({
    route,
    itemsResult,
    kanbanBuckets,
    wormholes,
    calendarState,
    publicCalendarFilter,
    columnIds,
  });
};

export const loadSpaceItemDetail = async (params: {
  user: AuthUser;
  spaceId: string;
  itemId: string;
  occurrenceId?: string | null;
  dateConfig?: DateContext;
  cookieHeader?: string;
  authorizationHeader?: string;
}): Promise<{ kind: "ok"; detail: SpaceItemDetail } | Extract<SpacesWorkspaceState, { kind: "notFound" | "accessDenied" }>> => {
  const { t } = spaceMessages.resolve(params.dateConfig?.locale ? [params.dateConfig.locale] : []);
  const [space, permissions] = await Promise.all([
    spacesService.space.get({ id: params.spaceId }),
    resolvePermissions({ spaceId: params.spaceId, user: params.user }),
  ]);
  if (!space) return { kind: "notFound", title: t.notFound, message: t.spaceNotFound };
  if (!permissions) return { kind: "accessDenied", title: t.accessDenied, message: t.spaceAccessDenied };

  const item = await spacesService.item.get({ id: params.itemId });
  if (!item || item.spaceId !== params.spaceId) return { kind: "notFound", title: t.notFound, message: t.itemNotFound };
  const recurringDetail = params.occurrenceId
    ? await resolveRecurringDetail({
        item,
        occurrenceId: params.occurrenceId,
        spaceId: params.spaceId,
        dateConfig: params.dateConfig,
      })
    : null;
  if (params.occurrenceId && !recurringDetail) {
    return { kind: "notFound", title: t.notFound, message: t.occurrenceNotFound };
  }
  const detailItem = recurringDetail?.item ?? item;
  const recurringContext = recurringDetail?.context ?? null;
  const commentTarget = {
    itemId: recurringContext?.seriesItemId ?? detailItem.id,
    recurrenceId: recurringContext?.recurrenceId ?? null,
  };
  const comments = await spacesService.comment.list({
    itemId: commentTarget.itemId,
    recurrenceId: commentTarget.recurrenceId,
    viewerUserId: params.user.id,
    pagination: { page: 1, perPage: COMMENT_PAGE_SIZE },
  });
  const [work, references, attachments, checklist, blockedBy, blocks] = await Promise.all([
    detailItem.startsAt || detailItem.endsAt ? Promise.resolve(undefined) : spacesService.item.work.read(detailItem.id),
    spacesService.item.references.list({ itemId: detailItem.id }),
    detailItem.startsAt || detailItem.endsAt ? Promise.resolve([]) : spacesService.item.attachments.list({ itemId: detailItem.id }),
    detailItem.startsAt || detailItem.endsAt ? Promise.resolve([]) : spacesService.item.checklist.list({ itemId: detailItem.id }),
    spacesService.item.dependencies.list({ itemId: detailItem.id }),
    spacesService.item.dependencies.listBlocks({ blockerItemId: detailItem.id }),
  ]);
  return {
    kind: "ok",
    detail: await projectItemDetail({
      item: detailItem,
      work,
      comments,
      commentTarget,
      recurringContext,
      references: await resolveReferenceViews(references, {
        cookie: params.cookieHeader,
        authorization: params.authorizationHeader,
      }),
      attachments,
      checklist,
      blockedBy,
      blocks,
    }),
  };
};

export const loadSpacesWorkspaceState = async (params: WorkspaceRequest): Promise<SpacesWorkspaceState> => {
  const authorized = await authorizeWorkspace(params);
  if (!authorized.ok) return authorized.error;

  // Capture after authorization but before any snapshot reads. Replaying an
  // event already reflected below is harmless; starting after it can miss one.
  const eventCursor = await loadEventCursor(params.spaceId);
  const context = await loadWorkspaceContext(params, authorized.value);
  if (!context.ok) return context.error;
  const { route, space, publicSpace, permissions, calendarFilter, publicCalendarFilter, columnIds } = context.value;

  const { wormholes, itemsResult, kanbanBuckets, calendarState } = await loadWorkspaceData({
    route,
    space,
    permissions,
    request: params,
    calendarFilter,
  });

  const selectedItemDetail = await loadSelectedItemState({
    selectedItemId: route.selectedItemId,
    selectedOccurrenceId: route.selectedOccurrenceId,
    itemsResult,
    spaceId: params.spaceId,
    userId: params.user.id,
    dateConfig: params.dateConfig,
    cookieHeader: params.cookieHeader,
    authorizationHeader: params.authorizationHeader,
  });
  const [publicItemsResult, publicKanbanBuckets, publicCalendarItems, publicWormholes] = await Promise.all([
    projectItemResult(itemsResult),
    projectKanbanBuckets(kanbanBuckets, columnIds),
    spacesPublicResources.projectCalendarItems(calendarState.calendarItems),
    spacesPublicResources.projectWormholes(wormholes),
  ]);

  return {
    kind: "ok",
    title: buildWorkspaceTitle(publicSpace, params.dateConfig?.locale),
    currentUserId: params.user.id,
    space: publicSpace,
    settings: route.settings,
    currentView: route.currentView,
    hasOverride: route.hasOverride,
    isAdmin: permissions.isAdmin,
    canWrite: permissions.canWrite,
    query: route.url.searchParams.toString(),
    icalBaseUrl: `${route.url.protocol}//${route.url.host}`,
    eventCursor,
    itemsResult: publicItemsResult,
    kanbanBuckets: publicKanbanBuckets,
    calendarView: calendarState.calendarView,
    calendarDate: calendarState.calendarDate.toISOString(),
    calendarFilter: publicCalendarFilter,
    calendarItems: publicCalendarItems,
    calendarWeather: calendarState.calendarWeather,
    selectedItemDetail,
    wormholes: publicWormholes,
  };
};
