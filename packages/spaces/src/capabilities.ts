import { createHash } from "node:crypto";
import { err, fail, ok, type Paginated, type Result } from "@k2b/stdlib";
import {
  type CapabilityActionReview,
  type CapabilityExecutionContext,
  type CapabilityInvocationResult,
  type CapabilityResult,
  type CloudResourceView,
  capabilityPage,
  defineCapabilities,
  UniversalSearchDataSchema,
  type UniversalSearchInput,
  UniversalSearchInputSchema,
} from "@valentinkolb/cloud/contracts";
import { hasPermission, type PermissionLevel } from "@valentinkolb/cloud/server";
import { type AuditActor, audit } from "@valentinkolb/cloud/services";
import { get as settingsGet } from "@valentinkolb/cloud/services/settings";
import { normalizeTimeZone } from "@valentinkolb/cloud/shared";
import type { z } from "zod";
import {
  CalendarDestinationListDataSchema,
  CalendarDestinationListInputSchema,
  CalendarInvitationImportCapabilityDataSchema,
  CalendarInvitationImportCapabilityInputSchema,
  CalendarInvitationPreviewCapabilityDataSchema,
  CalendarInvitationPreviewCapabilityInputSchema,
  CalendarInvitationResponseCommitCapabilityDataSchema,
  CalendarInvitationResponseCommitCapabilityInputSchema,
  CalendarInvitationResponsePrepareDataSchema,
  CalendarInvitationResponsePrepareInputSchema,
  CommentCreateInputSchema,
  CommentDataSchema,
  CommentDeleteDataSchema,
  CommentDeleteInputSchema,
  CommentListDataSchema,
  CommentListInputSchema,
  CommentReadInputSchema,
  CommentUpdateInputSchema,
  EventCreateInputSchema,
  EventDataSchema,
  EventInvitationCommitDataSchema,
  EventInvitationCommitInputSchema,
  EventInvitationPrepareDataSchema,
  EventInvitationPrepareInputSchema,
  EventListDataSchema,
  EventListInputSchema,
  EventUpdateInputSchema,
  ItemDataSchema,
  ItemDeleteDataSchema,
  ItemDeleteInputSchema,
  ItemLinkCandidateSearchInputSchema,
  ItemReadInputSchema,
  ItemResourceReferenceAddInputSchema,
  ItemResourceReferenceDataSchema,
  ItemResourceReferenceFindDataSchema,
  ItemResourceReferenceFindInputSchema,
  ItemResourceReferenceListDataSchema,
  ItemResourceReferenceListInputSchema,
  ItemResourceReferenceRemoveDataSchema,
  ItemResourceReferenceRemoveInputSchema,
  SpaceAssigneeListDataSchema,
  SpaceAssigneeListInputSchema,
  SpaceDetailDataSchema,
  SpaceListDataSchema,
  SpaceListInputSchema,
  SpaceReadInputSchema,
  TaskCreateInputSchema,
  TaskDataSchema,
  TaskDependencyDataSchema,
  TaskDependencyInputSchema,
  TaskDependencyListDataSchema,
  TaskDependencyListInputSchema,
  TaskDependencyRemoveDataSchema,
  TaskDependentListDataSchema,
  TaskListDataSchema,
  TaskListInputSchema,
  TaskSetCompletedInputSchema,
  TaskUpdateInputSchema,
} from "./capability-contracts";
import type { MutationResult, SpaceComment, SpaceItem } from "./contracts";
import { summarizeRecurrence } from "./presentation/recurrence";
import { buildSpaceItemHref } from "./routes";
import type { ItemAcrossKind, SpaceWithPermission } from "./service";
import { spacesService } from "./service";
import { isSpaceResourceId, resolveSpaceApiKeyPermission, SPACE_RESOURCE_TYPE, SPACES_APP_ID } from "./service/access";
import { spacesPublicResources } from "./service/public-resources";

const encodeCursor = (page: number): string => Buffer.from(JSON.stringify({ v: 1, page }), "utf8").toString("base64url");

const stableUuid = (value: string): string => {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const truncateText = (value: string, maxBytes: number): { text: string; truncated: boolean } => {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  const chunks: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    chunks.push(character);
    bytes += characterBytes;
  }
  return { text: chunks.join(""), truncated: true };
};

type ReviewDetails = NonNullable<CapabilityActionReview["details"]>;

const capabilityDateConfig = async () => ({
  timeZone: normalizeTimeZone(String((await settingsGet<string>("app.timezone")) || "").trim(), "UTC"),
  locale: "en" as const,
  firstDayOfWeek: 1 as const,
});

const relationReviewDetails = async (
  input: { assigneeIds?: string[]; tagIds?: string[] },
  internalSpaceId: string,
): Promise<ReviewDetails> => {
  const [users, detail] = await Promise.all([
    input.assigneeIds ? spacesService.item.listAssignableUsers({ spaceId: internalSpaceId, search: "", limit: 100 }) : Promise.resolve([]),
    input.tagIds ? spacesService.space.getDetail({ id: internalSpaceId }) : Promise.resolve(null),
  ]);
  const userNames = new Map(users.map((user) => [user.id, user.displayName]));
  const publicTags = detail ? await spacesPublicResources.projectTags(detail.tags) : [];
  const tagNames = new Map(publicTags.map((tag) => [tag.id, tag.name]));
  return [
    ...(input.assigneeIds
      ? [
          {
            label: "Assignees",
            value: input.assigneeIds.map((id) => userNames.get(id) ?? id).join(", ") || "None",
          },
        ]
      : []),
    ...(input.tagIds ? [{ label: "Tags", value: input.tagIds.map((id) => tagNames.get(id) ?? id).join(", ") || "None" }] : []),
  ];
};

const boundedText = (value: string | null, maxBytes: number): { text: string | null; truncated: boolean } =>
  value === null ? { text: null, truncated: false } : truncateText(value, maxBytes);

const eventInvitationIdempotencyId = (context: CapabilityExecutionContext, key: string): string => {
  const subject =
    context.accessSubject.type === "user"
      ? `user:${context.accessSubject.userId}:${context.accessSubject.delegatedByServiceAccountId ?? "direct"}`
      : `service_account:${context.accessSubject.serviceAccountId}`;
  return stableUuid(`spaces:event.invitation.prepare:${subject}:${key}`);
};

export const decodeSpacesCapabilityCursor = (cursor: string | undefined): Result<number> => {
  if (!cursor) return ok(1);
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; page?: unknown };
    return value.v === 1 && Number.isInteger(value.page) && Number(value.page) >= 1
      ? ok(Number(value.page))
      : fail(err.badInput("Invalid cursor"));
  } catch {
    return fail(err.badInput("Invalid cursor"));
  }
};

const pageResult = <T>(
  page: Paginated<unknown>,
  data: T,
  refs?: CapabilityResult<T>["refs"],
  links?: CapabilityResult<T>["links"],
): CapabilityInvocationResult<T> =>
  ok({
    data,
    ...(refs ? { refs } : {}),
    ...(links ? { links } : {}),
    page: capabilityPage(page.hasNext ? encodeCursor(page.page + 1) : undefined),
  });

const permissionFromScopes = (scopes: string[]): PermissionLevel => resolveSpaceApiKeyPermission("admin", scopes);

const scopedSpaceId = (context: CapabilityExecutionContext, required: PermissionLevel): Result<string | null> => {
  if (context.actor.kind === "user") {
    return context.accessSubject.type === "user" ? ok(null) : fail(err.forbidden("Access denied"));
  }
  const account = context.actor.serviceAccount;
  if (account.kind === "user_delegated") {
    return context.accessSubject.type === "user" && context.user ? ok(null) : fail(err.forbidden("Access denied"));
  }
  if (
    account.appId !== SPACES_APP_ID ||
    account.resourceType !== SPACE_RESOURCE_TYPE ||
    !isSpaceResourceId(account.resourceId) ||
    context.accessSubject.type !== "service_account" ||
    !hasPermission(permissionFromScopes(context.actor.scopes), required)
  ) {
    return fail(err.forbidden("Access denied"));
  }
  return ok(account.resourceId);
};

const effectivePermission = (permission: Exclude<PermissionLevel, "none">, context: CapabilityExecutionContext) =>
  context.actor.kind === "service_account" && context.actor.serviceAccount.kind === "resource_bound"
    ? resolveSpaceApiKeyPermission(permission, context.actor.scopes)
    : permission;

const requireSpaceUuid = async (spaceId: string, context: CapabilityExecutionContext, required: PermissionLevel = "read") => {
  const scope = scopedSpaceId(context, required);
  if (!scope.ok) return scope;
  if (scope.data && scope.data !== spaceId) return fail(err.notFound("Space"));
  const space = await spacesService.space.get({ id: spaceId });
  if (!space) return fail(err.notFound("Space"));
  const granted = await spacesService.space.permission.get({ spaceId, subject: context.accessSubject });
  const permission = granted === "none" ? "none" : effectivePermission(granted, context);
  if (!hasPermission(permission, required)) return fail(err.notFound("Space"));
  const [publicSpace] = await spacesPublicResources.projectSpaces([space]);
  return publicSpace ? ok({ space: publicSpace, internalId: spaceId, permission }) : fail(err.notFound("Space"));
};

const requireSpace = async (shortId: string, context: CapabilityExecutionContext, required: PermissionLevel = "read") => {
  const spaceId = await spacesPublicResources.resolvePublicId("spaces", shortId);
  return spaceId ? requireSpaceUuid(spaceId, context, required) : fail(err.notFound("Space"));
};

const requireItemUuid = async (internalId: string, context: CapabilityExecutionContext, required: PermissionLevel = "read") => {
  const item = await spacesService.item.get({ id: internalId });
  if (!item) return fail(err.notFound("Item"));
  const access = await requireSpaceUuid(item.spaceId, context, required);
  if (!access.ok) return fail(err.notFound("Item"));
  const [publicItem] = await spacesPublicResources.projectItems([item]);
  return publicItem
    ? ok({ item: publicItem, internalId, internalSpaceId: item.spaceId, permission: access.data.permission })
    : fail(err.notFound("Item"));
};

const requireItem = async (itemId: string, context: CapabilityExecutionContext, required: PermissionLevel = "read") => {
  const internalId = await spacesPublicResources.resolvePublicId("items", itemId);
  return internalId ? requireItemUuid(internalId, context, required) : fail(err.notFound("Item"));
};

const isEvent = (item: SpaceItem): item is SpaceItem & { startsAt: string; endsAt: string } => Boolean(item.startsAt && item.endsAt);

const mapRelations = (item: SpaceItem) => ({
  assignees: (item.assignees ?? [])
    .slice(0, 100)
    .map((entry) => ({ id: entry.id, displayName: truncateText(entry.displayName, 200).text })),
  tags: (item.tags ?? [])
    .slice(0, 100)
    .map((entry) => ({ id: entry.id, name: truncateText(entry.name, 100).text, color: truncateText(entry.color, 100).text })),
  relationsTruncated:
    (item.assignees?.length ?? 0) > 100 ||
    (item.tags?.length ?? 0) > 100 ||
    (item.assignees ?? []).some((entry) => truncateText(entry.displayName, 200).truncated) ||
    (item.tags ?? []).some((entry) => truncateText(entry.name, 100).truncated || truncateText(entry.color, 100).truncated),
});

const mapListRelations = (item: SpaceItem) => ({
  assignees: (item.assignees ?? []).slice(0, 3).map((entry) => ({ id: entry.id, displayName: truncateText(entry.displayName, 100).text })),
  tags: (item.tags ?? [])
    .slice(0, 3)
    .map((entry) => ({ id: entry.id, name: truncateText(entry.name, 50).text, color: truncateText(entry.color, 20).text })),
  relationsTruncated:
    (item.assignees?.length ?? 0) > 3 ||
    (item.tags?.length ?? 0) > 3 ||
    (item.assignees ?? []).some((entry) => truncateText(entry.displayName, 100).truncated) ||
    (item.tags ?? []).some((entry) => truncateText(entry.name, 50).truncated || truncateText(entry.color, 20).truncated),
});

const mapTask = (item: SpaceItem) => {
  const title = truncateText(item.title, 200);
  const description = boundedText(item.description, 5000);
  return {
    kind: "task" as const,
    id: item.id,
    spaceId: item.spaceId,
    columnId: item.columnId,
    title: title.text,
    titleTruncated: title.truncated,
    description: description.text,
    descriptionTruncated: description.truncated,
    deadline: item.deadline,
    estimatedDurationMinutes: item.estimatedDurationMinutes,
    activeBlockerCount: item.activeBlockerCount,
    priority: item.priority,
    completedAt: item.completedAt,
    ...mapRelations(item),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
};

const mapEvent = (item: SpaceItem & { startsAt: string; endsAt: string }) => {
  const title = truncateText(item.title, 200);
  const description = boundedText(item.description, 5000);
  const location = boundedText(item.location, 500);
  const url = boundedText(item.url, 2000);
  const recurrenceRule = item.recurrence ? truncateText(item.recurrence.rrule, 2000) : null;
  return {
    kind: "event" as const,
    id: item.id,
    spaceId: item.spaceId,
    columnId: item.columnId,
    title: title.text,
    titleTruncated: title.truncated,
    description: description.text,
    descriptionTruncated: description.truncated,
    location: location.text,
    locationTruncated: location.truncated,
    url: url.text,
    urlTruncated: url.truncated,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    allDay: item.allDay,
    recurrence: item.recurrence ? { ...item.recurrence, rrule: recurrenceRule!.text, exdate: item.recurrence.exdate.slice(0, 1000) } : null,
    recurrenceTruncated: recurrenceRule?.truncated ?? false,
    recurrenceExceptionsTruncated: (item.recurrence?.exdate.length ?? 0) > 1000,
    completedAt: item.completedAt,
    ...mapRelations(item),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
};

const mapItem = (item: SpaceItem) => (isEvent(item) ? mapEvent(item) : mapTask(item));

const mapTaskSummary = (item: SpaceItem) => {
  const description = boundedText(item.description, 1000);
  return {
    kind: "task" as const,
    id: item.id,
    spaceId: item.spaceId,
    columnId: item.columnId,
    title: truncateText(item.title, 200).text,
    descriptionPreview: description.text,
    descriptionTruncated: description.truncated,
    deadline: item.deadline,
    estimatedDurationMinutes: item.estimatedDurationMinutes,
    activeBlockerCount: item.activeBlockerCount,
    priority: item.priority,
    completedAt: item.completedAt,
    ...mapListRelations(item),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
};

const mapEventSummary = (item: SpaceItem & { startsAt: string; endsAt: string }) => {
  const description = boundedText(item.description, 1000);
  const location = boundedText(item.location, 200);
  const url = boundedText(item.url, 500);
  return {
    kind: "event" as const,
    id: item.id,
    spaceId: item.spaceId,
    columnId: item.columnId,
    title: truncateText(item.title, 200).text,
    descriptionPreview: description.text,
    descriptionTruncated: description.truncated,
    location: location.text,
    locationTruncated: location.truncated,
    url: url.text,
    urlTruncated: url.truncated,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    allDay: item.allDay,
    hasRecurrence: item.recurrence !== null,
    completedAt: item.completedAt,
    ...mapListRelations(item),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
};

const mapComment = (comment: SpaceComment) => ({
  id: comment.id,
  itemId: comment.itemId,
  recurrenceId: comment.recurrenceId,
  userId: comment.userId,
  userName: comment.userName,
  content: comment.content,
  createdAt: comment.createdAt,
  updatedAt: comment.updatedAt,
  canEdit: comment.canEdit,
  canDelete: comment.canDelete,
});

const mapCommentSummary = (comment: SpaceComment) => {
  const content = truncateText(comment.content, 1000);
  return { ...mapComment(comment), content: content.text, contentTruncated: content.truncated };
};

const mapSpace = (space: SpaceWithPermission, context: CapabilityExecutionContext) => ({
  id: space.id,
  name: space.name,
  description: space.description,
  color: space.color,
  permission: effectivePermission(space.permission, context) as "read" | "write" | "admin",
  createdAt: space.createdAt,
  updatedAt: space.updatedAt,
});

const runSpaceSearch = async (input: UniversalSearchInput, context: CapabilityExecutionContext) => {
  const scope = scopedSpaceId(context, "read");
  if (!scope.ok) return ok({ data: [] });
  const page = await spacesService.space.listWithPermission({
    subject: context.accessSubject,
    boundSpaceId: scope.data,
    query: input.query,
    pagination: { page: 1, perPage: input.limit },
  });
  const publicSpaces = await spacesPublicResources.projectSpaces(page.items);
  const data: CloudResourceView[] = publicSpaces.map((entry) => ({
    ref: { type: "spaces.space", id: entry.id },
    title: entry.name,
    preview: entry.description ?? undefined,
    icon: "ti ti-layout-kanban",
    priority: 7,
    metadata: [{ label: "Type", value: "Space" }],
    links: [{ rel: "open", href: `/app/spaces/${entry.id}` }],
  }));
  return ok({ data });
};

const runItemSearch = async (
  input: UniversalSearchInput,
  context: CapabilityExecutionContext,
  requiredLevel: "read" | "write" = "read",
) => {
  const scope = scopedSpaceId(context, requiredLevel);
  if (!scope.ok) return ok({ data: [] });

  const tags = new Set(input.tags);
  const wantsTasks = tags.has("task") || tags.has("tasks") || tags.has("todo") || tags.has("kanban");
  const wantsEvents = tags.has("event") || tags.has("events") || tags.has("calendar");
  let kinds: ItemAcrossKind = "all";
  if (wantsTasks && !wantsEvents) kinds = "task";
  else if (wantsEvents && !wantsTasks) kinds = "event";

  const hits = await spacesService.item.searchAcross({
    subject: context.accessSubject,
    boundSpaceId: scope.data,
    query: input.query,
    kinds,
    status: tags.has("todo") ? "open" : undefined,
    priority: tags.has("urgent") ? ["urgent"] : undefined,
    requiredLevel,
    limit: input.limit,
  });
  const [publicItems, publicSpaces] = await Promise.all([
    spacesPublicResources.projectItems(hits.map((hit) => hit.item)),
    spacesPublicResources.projectSpaces(hits.map((hit) => hit.space)),
  ]);
  const data: CloudResourceView[] = hits.map((_, index) => {
    const item = publicItems[index]!;
    const space = publicSpaces[index]!;
    return {
      ref: { type: "spaces.item", id: item.id },
      title: item.title,
      preview: item.description === null ? undefined : truncateText(item.description, 2000).text,
      icon: isEvent(item) ? "ti ti-calendar-event" : "ti ti-checkbox",
      priority: 8,
      metadata: [
        { label: "Type", value: "Space Item" },
        { label: "Space", value: space.name },
        { label: "Item Kind", value: isEvent(item) ? "Event" : "Task" },
      ],
      links: [{ rel: "open", href: buildSpaceItemHref(space.id, item.id) }],
    };
  });
  return ok({ data });
};

const runItemReferenceFind = async (input: z.infer<typeof ItemResourceReferenceFindInputSchema>, context: CapabilityExecutionContext) => {
  const scope = scopedSpaceId(context, "read");
  if (!scope.ok) return scope;
  const spaces = await spacesService.space.list({
    subject: context.accessSubject,
    boundSpaceId: scope.data,
    requiredLevel: "read",
  });
  const itemIds = await spacesService.item.references.findItemIds({
    ref: input.ref,
    spaceIds: spaces.items.map((space) => space.id),
    limit: input.limit + 1,
  });
  const truncated = itemIds.length > input.limit;
  const items = (await Promise.all(itemIds.slice(0, input.limit).map((id) => spacesService.item.get({ id })))).filter(
    (item): item is SpaceItem => item !== null,
  );
  const [publicItems, publicSpaces] = await Promise.all([
    spacesPublicResources.projectItems(items),
    spacesPublicResources.projectSpaces(spaces.items),
  ]);
  const spaceByInternalId = new Map(spaces.items.map((space, index) => [space.id, publicSpaces[index]]));
  const data: CloudResourceView[] = publicItems.map((item, index) => {
    const internalItem = items[index]!;
    const space = spaceByInternalId.get(internalItem.spaceId)!;
    return {
      ref: { type: "spaces.item", id: item.id },
      title: item.title,
      preview: item.description ?? undefined,
      icon: isEvent(item) ? "ti ti-calendar-event" : "ti ti-checkbox",
      metadata: [
        { label: "Space", value: space.name },
        { label: "Item Kind", value: isEvent(item) ? "Event" : "Task" },
      ],
      links: [{ rel: "open", href: buildSpaceItemHref(space.id, item.id) }],
    };
  });
  return ok({ data: { items: data, truncated } });
};

const runSpaceList = async (input: z.infer<typeof SpaceListInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeSpacesCapabilityCursor(input.cursor);
  if (!cursor.ok) return cursor;
  const scope = scopedSpaceId(context, input.minimumPermission);
  if (!scope.ok) return scope;
  const page = await spacesService.space.listWithPermission({
    subject: context.accessSubject,
    boundSpaceId: scope.data,
    requiredLevel: input.minimumPermission,
    query: input.query,
    pagination: { page: cursor.data, perPage: input.limit },
  });
  const publicSpaces = await spacesPublicResources.projectSpaces(page.items);
  const data = publicSpaces.map((space) => ({
    ...mapSpace(space, context),
    links: [{ rel: "open" as const, href: `/app/spaces/${space.id}` }],
  }));
  return pageResult(
    page,
    data,
    data.map((space) => ({ type: "spaces.space", id: space.id })),
  );
};

const runSpaceRead = async (input: z.infer<typeof SpaceReadInputSchema>, context: CapabilityExecutionContext) => {
  const access = await requireSpace(input.id, context);
  if (!access.ok) return access;
  const detail = await spacesService.space.getDetail({ id: access.data.internalId });
  if (!detail) return fail(err.notFound("Space"));
  const [publicDetail] = await spacesPublicResources.projectSpaces([detail]);
  const [columns, tags] = await Promise.all([
    spacesPublicResources.projectColumns(detail.columns),
    spacesPublicResources.projectTags(detail.tags),
  ]);
  if (!publicDetail) return fail(err.notFound("Space"));
  return ok({
    data: {
      id: publicDetail.id,
      name: publicDetail.name,
      description: publicDetail.description,
      color: publicDetail.color,
      permission: access.data.permission as "read" | "write" | "admin",
      columns: columns.slice(0, 100).map((column) => ({
        id: column.id,
        name: column.name,
        color: column.color,
        isDone: column.isDone,
      })),
      columnsTruncated: columns.length > 100,
      tags: tags.slice(0, 100).map((tag) => ({ id: tag.id, name: tag.name, color: tag.color })),
      tagsTruncated: tags.length > 100,
      createdAt: publicDetail.createdAt,
      updatedAt: publicDetail.updatedAt,
    },
    refs: [{ type: "spaces.space", id: publicDetail.id }],
    links: [{ rel: "open" as const, href: `/app/spaces/${publicDetail.id}` }],
  });
};

const runSpaceAssigneeList = async (input: z.infer<typeof SpaceAssigneeListInputSchema>, context: CapabilityExecutionContext) => {
  const access = await requireSpace(input.spaceId, context, "write");
  if (!access.ok) return access;
  const users = await spacesService.item.listAssignableUsers({
    spaceId: access.data.internalId,
    search: input.query,
    limit: input.limit,
  });
  return ok({
    data: users.map((user) => ({
      id: user.id,
      displayName: truncateText(user.displayName, 200).text,
      description: truncateText(user.description ?? "", 300).text,
    })),
  });
};

type ItemListInput = z.infer<typeof TaskListInputSchema> | z.infer<typeof EventListInputSchema>;

const runItemList = async (input: ItemListInput, context: CapabilityExecutionContext, kind: "task" | "event") => {
  const cursor = decodeSpacesCapabilityCursor(input.cursor);
  if (!cursor.ok) return cursor;
  if (input.assignedTo === "me" && !context.user) return fail(err.forbidden("The me filter requires a user-backed actor"));
  const access = await requireSpace(input.spaceId, context);
  if (!access.ok) return access;
  const [columnIds, tagIds] = await Promise.all([
    spacesPublicResources.resolveSpacePublicIds("columns", access.data.internalId, input.columnIds ?? []),
    spacesPublicResources.resolveSpacePublicIds("tags", access.data.internalId, input.tagIds ?? []),
  ]);
  if (!columnIds || !tagIds) return fail(err.badInput("Unknown Space filter ID"));
  const page = await spacesService.item.listFiltered({
    spaceId: access.data.internalId,
    currentUserId: context.user?.id,
    filter: {
      type: kind,
      status: input.status,
      priority: input.priority,
      columnIds,
      tagIds,
      assigneeIds: input.assigneeIds,
      assignedTo: input.assignedTo,
      deadlineFilter: "all",
      search: input.query,
      sort: input.sort,
      sortDesc: input.sortDesc,
      groupBy: "none",
      page: cursor.data,
      pageSize: input.limit,
    },
  });
  const publicItems = await spacesPublicResources.projectItems(page.items);
  const items = (
    kind === "event" ? publicItems.filter(isEvent).map(mapEventSummary) : publicItems.filter((item) => !isEvent(item)).map(mapTaskSummary)
  ).map((item) => ({
    ...item,
    links: [{ rel: "open" as const, href: buildSpaceItemHref(item.spaceId, item.id) }],
  }));
  return pageResult(
    { items: page.items, page: page.page, perPage: page.pageSize, total: page.total, hasNext: page.page < page.totalPages },
    items,
    items.map((item) => ({ type: "spaces.item", id: item.id })),
  );
};

const runItemRead = async (input: z.infer<typeof ItemReadInputSchema>, context: CapabilityExecutionContext) => {
  const resolved = await requireItem(input.id, context);
  if (!resolved.ok) return resolved;
  return ok({
    data: mapItem(resolved.data.item),
    refs: [{ type: "spaces.item", id: resolved.data.item.id }],
    links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, resolved.data.item.id) }],
  });
};

const runCommentList = async (input: z.infer<typeof CommentListInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeSpacesCapabilityCursor(input.cursor);
  if (!cursor.ok) return cursor;
  const resolved = await requireItem(input.itemId, context);
  if (!resolved.ok) return resolved;
  const page = await spacesService.comment.list({
    itemId: resolved.data.internalId,
    recurrenceId: input.recurrenceId,
    viewerUserId: context.user?.id ?? null,
    pagination: { page: cursor.data, perPage: input.limit },
    filter: { query: input.query },
  });
  const data = (await spacesPublicResources.projectComments(page.items)).map(mapCommentSummary);
  return pageResult(
    page,
    data,
    data.map((comment) => ({ type: "spaces.comment", id: comment.id })),
    [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, resolved.data.item.id) }],
  );
};

const resolveComment = async (commentId: string, context: CapabilityExecutionContext, required: PermissionLevel = "read") => {
  const internalId = await spacesPublicResources.resolvePublicId("comments", commentId);
  if (!internalId) return fail(err.notFound("Comment"));
  const comment = await spacesService.comment.get({ id: internalId, viewerUserId: context.user?.id ?? null });
  if (!comment) return fail(err.notFound("Comment"));
  const item = await requireItemUuid(comment.itemId, context, required);
  const [publicComment] = await spacesPublicResources.projectComments([comment]);
  return item.ok && publicComment
    ? ok({ comment: publicComment, internalId, item: item.data.item, internalItemId: comment.itemId })
    : fail(err.notFound("Comment"));
};

const runCommentRead = async (input: z.infer<typeof CommentReadInputSchema>, context: CapabilityExecutionContext) => {
  const resolved = await resolveComment(input.id, context);
  if (!resolved.ok) return resolved;
  return ok({
    data: mapComment(resolved.data.comment),
    refs: [
      { type: "spaces.comment", id: resolved.data.comment.id },
      { type: "spaces.item", id: resolved.data.item.id },
    ],
    links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, resolved.data.item.id) }],
  });
};

const capabilityAuditActor = (context: CapabilityExecutionContext): AuditActor =>
  context.actor.kind === "user"
    ? {
        userId: context.actor.user.id,
        uid: context.actor.user.uid,
        provider: context.actor.user.provider,
        roles: context.actor.user.roles,
      }
    : {
        uid: `service-account:${context.actor.serviceAccount.id}`,
        provider: "service_account",
        roles: context.actor.scopes,
      };

const actionAudit = (context: CapabilityExecutionContext, actionId: string, targetType: string, targetId: string) => ({
  action: `spaces.capability.${actionId}`,
  actor: capabilityAuditActor(context),
  target: { type: targetType, id: targetId },
  metadata: { capability: `spaces.${actionId}` },
});

const audited = async <T>(
  params: ReturnType<typeof actionAudit>,
  operation: () => Promise<CapabilityInvocationResult<T>>,
): Promise<CapabilityInvocationResult<T>> => {
  const result = await operation();
  return result.ok ? audit.recordResultAfterSideEffect({ ...params, result }) : audit.recordResult({ ...params, result });
};

const mutationError = <T>(result: Exclude<MutationResult<T>, { ok: true }>) => {
  if (result.status === 403) return fail(err.forbidden(result.error));
  if (result.status === 404) return fail(err.notFound(result.error.replace(/ not found$/i, "")));
  if (result.status === 409) return fail(err.conflict(result.error));
  if (result.status === 500) return fail(err.internal(result.error));
  return fail(err.badInput(result.error));
};

const itemMutationResult = async (result: MutationResult<SpaceItem>) => {
  if (!result.ok) return mutationError(result);
  const [item] = await spacesPublicResources.projectItems([result.data]);
  if (!item) return fail(err.internal("Failed to project Space item"));
  return ok({
    data: mapItem(item),
    refs: [{ type: "spaces.item", id: item.id }],
    links: [{ rel: "open" as const, href: buildSpaceItemHref(item.spaceId, item.id) }],
  });
};

const runItemReferenceList = async (input: z.infer<typeof ItemResourceReferenceListInputSchema>, context: CapabilityExecutionContext) => {
  const resolved = await requireItem(input.itemId, context, "read");
  if (!resolved.ok) return resolved;
  return ok({
    data: await spacesService.item.references.list({ itemId: resolved.data.internalId }),
    refs: [{ type: "spaces.item", id: input.itemId }],
    links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
  });
};

const runItemReferenceAdd = async (input: z.infer<typeof ItemResourceReferenceAddInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "item.reference.add", "space_item", input.itemId), async () => {
    const resolved = await requireItem(input.itemId, context, "write");
    if (!resolved.ok) return resolved;
    const data = await spacesService.item.references.add({
      itemId: resolved.data.internalId,
      spaceId: resolved.data.internalSpaceId,
      reference: input.reference,
    });
    if (!data) return fail(err.conflict("Space item already has the maximum number of linked resources"));
    return ok({
      data,
      refs: [{ type: "spaces.item", id: input.itemId }, input.reference.ref],
      links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
    });
  });

const runItemReferenceRemove = async (input: z.infer<typeof ItemResourceReferenceRemoveInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "item.reference.remove", "space_item", input.itemId), async () => {
    const resolved = await requireItem(input.itemId, context, "write");
    if (!resolved.ok) return resolved;
    const deleted = await spacesService.item.references.remove({
      itemId: resolved.data.internalId,
      spaceId: resolved.data.internalSpaceId,
      ref: input.ref,
    });
    return ok({
      data: { itemId: input.itemId, ref: input.ref, deleted },
      refs: [{ type: "spaces.item", id: input.itemId }, input.ref],
      links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
    });
  });

const runTaskDependencyList = async (input: z.infer<typeof TaskDependencyListInputSchema>, context: CapabilityExecutionContext) => {
  const resolved = await requireItem(input.itemId, context, "read");
  if (!resolved.ok) return resolved;
  if (isEvent(resolved.data.item)) return fail(err.badInput("Item is not a task"));
  return ok({
    data: await spacesPublicResources.projectTaskDependencies(
      await spacesService.item.dependencies.list({ itemId: resolved.data.internalId }),
    ),
    refs: [{ type: "spaces.item", id: input.itemId }],
    links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
  });
};

const runTaskDependentList = async (input: z.infer<typeof TaskDependencyListInputSchema>, context: CapabilityExecutionContext) => {
  const resolved = await requireItem(input.itemId, context, "read");
  if (!resolved.ok) return resolved;
  if (isEvent(resolved.data.item)) return fail(err.badInput("Item is not a task"));
  return ok({
    data: await spacesPublicResources.projectTaskDependents(
      await spacesService.item.dependencies.listBlocks({ blockerItemId: resolved.data.internalId }),
    ),
    refs: [{ type: "spaces.item", id: input.itemId }],
    links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
  });
};

const runTaskDependencyAdd = async (input: z.infer<typeof TaskDependencyInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "task.blocker.add", "space_item", input.itemId), async () => {
    const [resolved, blocker] = await Promise.all([
      requireItem(input.itemId, context, "write"),
      requireItem(input.blockerItemId, context, "read"),
    ]);
    if (!resolved.ok) return resolved;
    if (!blocker.ok) return blocker;
    if (isEvent(resolved.data.item) || isEvent(blocker.data.item)) return fail(err.badInput("Task dependencies can only connect tasks"));
    const result = await spacesService.item.dependencies.add({
      itemId: resolved.data.internalId,
      blockerItemId: blocker.data.internalId,
      spaceId: resolved.data.internalSpaceId,
    });
    if (!result.ok) return mutationError(result);
    const [data] = await spacesPublicResources.projectTaskDependencies([result.data]);
    if (!data) return fail(err.internal("Failed to project task dependency"));
    return ok({
      data,
      refs: [
        { type: "spaces.item", id: input.itemId },
        { type: "spaces.item", id: input.blockerItemId },
      ],
      links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
    });
  });

const runTaskDependencyRemove = async (input: z.infer<typeof TaskDependencyInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "task.blocker.remove", "space_item", input.itemId), async () => {
    const [resolved, blocker] = await Promise.all([
      requireItem(input.itemId, context, "write"),
      requireItem(input.blockerItemId, context, "read"),
    ]);
    if (!resolved.ok) return resolved;
    if (!blocker.ok) return blocker;
    const result = await spacesService.item.dependencies.remove({
      itemId: resolved.data.internalId,
      blockerItemId: blocker.data.internalId,
      spaceId: resolved.data.internalSpaceId,
    });
    if (!result.ok) return mutationError(result);
    return ok({
      data: { itemId: input.itemId, blockerItemId: input.blockerItemId, removed: true as const },
      refs: [
        { type: "spaces.item", id: input.itemId },
        { type: "spaces.item", id: input.blockerItemId },
      ],
      links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
    });
  });

const commentMutationResult = async (result: MutationResult<SpaceComment>, item: SpaceItem) => {
  if (!result.ok) return mutationError(result);
  const [comment] = await spacesPublicResources.projectComments([result.data]);
  if (!comment) return fail(err.internal("Failed to project Space comment"));
  return ok({
    data: mapComment(comment),
    refs: [
      { type: "spaces.comment", id: comment.id },
      { type: "spaces.item", id: item.id },
    ],
    links: [{ rel: "open" as const, href: buildSpaceItemHref(item.spaceId, item.id) }],
  });
};

const runTaskCreate = async (input: z.infer<typeof TaskCreateInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "task.create", "space", input.spaceId), async () => {
    const access = await requireSpace(input.spaceId, context, "write");
    if (!access.ok) return access;
    const { spaceId, ...data } = input;
    const [columnIds, tagIds] = await Promise.all([
      spacesPublicResources.resolveSpacePublicIds("columns", access.data.internalId, [data.columnId]),
      spacesPublicResources.resolveSpacePublicIds("tags", access.data.internalId, data.tagIds ?? []),
    ]);
    const columnId = columnIds?.[0];
    if (!columnId || !tagIds) return fail(err.badInput("Unknown Space column or tag"));
    return itemMutationResult(
      await spacesService.item.create({
        spaceId: access.data.internalId,
        data: { ...data, columnId, tagIds },
        createdBy: context.user?.id ?? null,
      }),
    );
  });

const runTaskUpdate = async (input: z.infer<typeof TaskUpdateInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "task.update", "space_item", input.itemId), async () => {
    const resolved = await requireItem(input.itemId, context, "write");
    if (!resolved.ok) return resolved;
    if (isEvent(resolved.data.item)) return fail(err.badInput("Item is not a task"));
    const { itemId, ...data } = input;
    const tagIds = await spacesPublicResources.resolveSpacePublicIds("tags", resolved.data.internalSpaceId, data.tagIds ?? []);
    if (!tagIds) return fail(err.badInput("Unknown Space tag"));
    return itemMutationResult(
      await spacesService.item.update({ id: resolved.data.internalId, data: { ...data, ...(data.tagIds ? { tagIds } : {}) } }),
    );
  });

const runTaskSetCompleted = async (input: z.infer<typeof TaskSetCompletedInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "task.set-completed", "space_item", input.itemId), async () => {
    const resolved = await requireItem(input.itemId, context, "write");
    if (!resolved.ok) return resolved;
    if (isEvent(resolved.data.item)) return fail(err.badInput("Item is not a task"));
    return itemMutationResult(await spacesService.item.setCompleted({ id: resolved.data.internalId, completed: input.completed }));
  });

const runEventCreate = async (input: z.infer<typeof EventCreateInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "event.create", "space", input.spaceId), async () => {
    const access = await requireSpace(input.spaceId, context, "write");
    if (!access.ok) return access;
    const { spaceId, ...data } = input;
    const [columnIds, tagIds] = await Promise.all([
      spacesPublicResources.resolveSpacePublicIds("columns", access.data.internalId, [data.columnId]),
      spacesPublicResources.resolveSpacePublicIds("tags", access.data.internalId, data.tagIds ?? []),
    ]);
    const columnId = columnIds?.[0];
    if (!columnId || !tagIds) return fail(err.badInput("Unknown Space column or tag"));
    return itemMutationResult(
      await spacesService.item.create({
        spaceId: access.data.internalId,
        data: { ...data, columnId, tagIds },
        createdBy: context.user?.id ?? null,
      }),
    );
  });

const runEventUpdate = async (input: z.infer<typeof EventUpdateInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "event.update", "space_item", input.itemId), async () => {
    const resolved = await requireItem(input.itemId, context, "write");
    if (!resolved.ok) return resolved;
    if (!isEvent(resolved.data.item)) return fail(err.badInput("Item is not an event"));
    const { itemId, ...data } = input;
    const tagIds = await spacesPublicResources.resolveSpacePublicIds("tags", resolved.data.internalSpaceId, data.tagIds ?? []);
    if (!tagIds) return fail(err.badInput("Unknown Space tag"));
    return itemMutationResult(
      await spacesService.item.update({ id: resolved.data.internalId, data: { ...data, ...(data.tagIds ? { tagIds } : {}) } }),
    );
  });

const runItemDelete = async (input: z.infer<typeof ItemDeleteInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "item.delete", "space_item", input.itemId), async () => {
    const resolved = await requireItem(input.itemId, context, "write");
    if (!resolved.ok) return resolved;
    const result = await spacesService.item.remove({ id: resolved.data.internalId });
    return result.ok ? ok({ data: { itemId: input.itemId, deleted: true as const } }) : mutationError(result);
  });

const runCommentCreate = async (input: z.infer<typeof CommentCreateInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "comment.create", "space_item", input.itemId), async () => {
    if (!context.user) return fail(err.forbidden("Comments require a user-backed actor"));
    const resolved = await requireItem(input.itemId, context, "write");
    if (!resolved.ok) return resolved;
    return commentMutationResult(
      await spacesService.comment.create({
        itemId: resolved.data.internalId,
        recurrenceId: input.recurrenceId,
        userId: context.user.id,
        content: input.content,
      }),
      resolved.data.item,
    );
  });

const runCommentUpdate = async (input: z.infer<typeof CommentUpdateInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "comment.update", "space_comment", input.commentId), async () => {
    if (!context.user) return fail(err.forbidden("Comments require a user-backed actor"));
    const resolved = await resolveComment(input.commentId, context, "write");
    if (!resolved.ok) return resolved;
    return commentMutationResult(
      await spacesService.comment.update({ id: resolved.data.internalId, content: input.content, userId: context.user.id }),
      resolved.data.item,
    );
  });

const runCommentDelete = async (input: z.infer<typeof CommentDeleteInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "comment.delete", "space_comment", input.commentId), async () => {
    if (!context.user) return fail(err.forbidden("Comments require a user-backed actor"));
    const resolved = await resolveComment(input.commentId, context, "write");
    if (!resolved.ok) return resolved;
    const result = await spacesService.comment.remove({ id: resolved.data.internalId, userId: context.user.id });
    return result.ok ? ok({ data: { commentId: input.commentId, deleted: true as const } }) : mutationError(result);
  });

const runCalendarInvitationPreview = async (
  input: z.infer<typeof CalendarInvitationPreviewCapabilityInputSchema>,
  context: CapabilityExecutionContext,
) => {
  const result = await spacesService.calendarInvitations.previewCalendarInvitation(input);
  if (!result.ok || !result.data.existing) return result.ok ? ok({ data: result.data }) : result;
  const access = await requireSpaceUuid(result.data.existing.spaceId, context, "read");
  const item = access.ok ? await requireItemUuid(result.data.existing.itemId, context, "read") : null;
  return access.ok && item?.ok
    ? ok({
        data: {
          ...result.data,
          existing: {
            ...result.data.existing,
            spaceId: access.data.space.id,
            itemId: item.data.item.id,
            href: buildSpaceItemHref(access.data.space.id, item.data.item.id),
          },
        },
        links: [{ rel: "open" as const, href: buildSpaceItemHref(access.data.space.id, item.data.item.id) }],
      })
    : ok({ data: { ...result.data, existing: null, response: null } });
};

const runCalendarInvitationResponsePrepare = async (
  input: z.infer<typeof CalendarInvitationResponsePrepareInputSchema>,
  context: CapabilityExecutionContext,
) => {
  const result = await spacesService.calendarInvitations.prepareCalendarResponse({ input, subject: context.accessSubject });
  return result.ok ? ok({ data: result.data }) : result;
};

const calendarDestinationContext = async (context: CapabilityExecutionContext) => {
  const scope = scopedSpaceId(context, "write");
  if (!scope.ok) return scope;
  const page = await spacesService.space.list({
    subject: context.accessSubject,
    boundSpaceId: scope.data,
    requiredLevel: "write",
    pagination: { page: 1, perPage: 100 },
  });
  const spaces = await spacesPublicResources.projectSpaces(page.items);
  return ok({
    data: spaces.map((space) => ({
      id: space.id,
      name: space.name,
      color: space.color,
      links: [{ rel: "open" as const, href: `/app/spaces/${space.id}` }],
    })),
  });
};

const runCalendarInvitationImport = async (
  input: z.infer<typeof CalendarInvitationImportCapabilityInputSchema>,
  context: CapabilityExecutionContext,
) =>
  audited(actionAudit(context, "calendar-invitation.import", "space", input.spaceId), async () => {
    if (!context.user) return fail(err.forbidden("Importing an invitation requires a user-backed actor"));
    const access = await requireSpace(input.spaceId, context, "write");
    if (!access.ok) return access;
    const result = await spacesService.calendarInvitations.importCalendarInvitation({
      input: { ...input, spaceId: access.data.internalId },
      user: context.user,
      subject: context.accessSubject,
    });
    if (!result.ok) return result;
    const item = await requireItemUuid(result.data.itemId, context, "read");
    if (!item.ok) return item;
    const data = {
      ...result.data,
      itemId: item.data.item.id,
      spaceId: item.data.item.spaceId,
      href: buildSpaceItemHref(item.data.item.spaceId, item.data.item.id),
    };
    return ok({
      data,
      refs: [{ type: "spaces.item", id: data.itemId }],
      links: [{ rel: "open", href: data.href }],
    });
  });

const runCalendarInvitationResponseCommit = async (
  input: z.infer<typeof CalendarInvitationResponseCommitCapabilityInputSchema>,
  context: CapabilityExecutionContext,
) =>
  audited(actionAudit(context, "calendar-invitation.response.commit", "mail_draft", input.draftId), async () => {
    const result = await spacesService.calendarInvitations.commitCalendarResponse({ input, subject: context.accessSubject });
    return result.ok
      ? ok({
          data: result.data,
          refs: [{ type: "mail.draft", id: input.draftId }],
        })
      : result;
  });

const runEventInvitationPrepare = async (input: z.infer<typeof EventInvitationPrepareInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "event.invitation.prepare", "space_item", input.itemId), async () => {
    if (!context.idempotencyKey) return fail(err.badInput("An idempotency key is required"));
    const resolved = await requireItem(input.itemId, context, "write");
    if (!resolved.ok) return resolved;
    if (!isEvent(resolved.data.item)) return fail(err.badInput("Item is not an event"));
    const result = await spacesService.calendarInvitations.prepareEventInvitationAttachment({
      ...input,
      spaceId: resolved.data.internalSpaceId,
      itemId: resolved.data.internalId,
      deliveryId: eventInvitationIdempotencyId(context, context.idempotencyKey),
      subject: context.accessSubject,
    });
    return result.ok
      ? ok({
          data: { ...result.data, itemId: resolved.data.item.id },
          refs: [
            { type: "spaces.item", id: resolved.data.item.id },
            { type: "mail.draft", id: result.data.draftId },
          ],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, resolved.data.item.id) }],
        })
      : result;
  });

const runEventInvitationCommit = async (input: z.infer<typeof EventInvitationCommitInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "event.invitation.commit", "calendar_invitation_delivery", input.deliveryId), async () => {
    const result = await spacesService.calendarInvitations.commitEventInvitationAttachment({
      deliveryId: input.deliveryId,
      subject: context.accessSubject,
    });
    if (!result.ok) return result;
    const resolved = await requireItemUuid(result.data.itemId, context);
    if (!resolved.ok) return resolved;
    return ok({
      data: { ...result.data, itemId: resolved.data.item.id },
      refs: [
        { type: "spaces.item", id: resolved.data.item.id },
        { type: "mail.draft", id: result.data.draftId },
      ],
      links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, resolved.data.item.id) }],
    });
  });

export const spacesCapabilities = defineCapabilities({
  protocolVersion: 1,
  types: {
    space: { title: "Space", description: "A permission-scoped collaboration space.", icon: "ti ti-layout-kanban", reader: "space.read" },
    item: { title: "Space item", description: "A task or event inside a space.", icon: "ti ti-checkbox", reader: "item.read" },
    comment: {
      title: "Space comment",
      description: "A user-authored comment attached to a Space item.",
      icon: "ti ti-message",
      reader: "comment.read",
    },
  },
  queries: {
    "space.search": {
      title: "Search spaces",
      description: "Find accessible Spaces by name or description.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: {
        tags: [{ tag: "space", title: "Spaces", description: "Show spaces only.", aliases: ["spaces"] }],
      },
      run: runSpaceSearch,
    },
    "item.search": {
      title: "Search Space items",
      description: "Find accessible tasks and events with optional workflow facets.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: {
        tags: [
          { tag: "task", title: "Tasks", description: "Show task items only.", aliases: ["tasks", "kanban"] },
          { tag: "todo", title: "Open tasks", description: "Show open tasks only." },
          { tag: "event", title: "Events", description: "Show items with a time range.", aliases: ["events", "calendar"] },
          { tag: "urgent", title: "Urgent", description: "Show urgent items only." },
        ],
      },
      run: runItemSearch,
    },
    "item.link-candidate.search": {
      title: "Search writable Space items",
      description: "Find writable tasks and events that can receive a Cloud resource link.",
      input: ItemLinkCandidateSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      run: (input, context) => runItemSearch({ ...input, tags: [] }, context, "write"),
    },
    "space.list": {
      title: "List spaces",
      description: "List accessible Spaces with effective permission and bounded SQL pagination.",
      input: SpaceListInputSchema,
      data: SpaceListDataSchema,
      openWorld: false,
      run: runSpaceList,
    },
    "space.read": {
      title: "Read space",
      description: "Read one accessible Space plus its bounded column and tag vocabulary.",
      input: SpaceReadInputSchema,
      data: SpaceDetailDataSchema,
      openWorld: false,
      run: runSpaceRead,
    },
    "space.assignee.list": {
      title: "List assignable Space members",
      description: "Find people who can be assigned to a task or calendar event in one writable Space.",
      input: SpaceAssigneeListInputSchema,
      data: SpaceAssigneeListDataSchema,
      openWorld: false,
      run: runSpaceAssigneeList,
    },
    "task.list": {
      title: "List tasks",
      description: "List task-shaped items in one readable Space with bounded filters and pagination.",
      input: TaskListInputSchema,
      data: TaskListDataSchema,
      openWorld: false,
      run: (input, context) => runItemList(input, context, "task"),
    },
    "event.list": {
      title: "List events",
      description: "List event-shaped items in one readable Space with bounded filters and pagination.",
      input: EventListInputSchema,
      data: EventListDataSchema,
      openWorld: false,
      run: (input, context) => runItemList(input, context, "event"),
    },
    "item.read": {
      title: "Read Space item",
      description: "Read one task or event by stable public item ID with an explicit kind discriminator.",
      input: ItemReadInputSchema,
      data: ItemDataSchema,
      openWorld: false,
      run: runItemRead,
    },
    "item.reference.find": {
      title: "Find items linked to a resource",
      description: "Find readable Space items linked to one stable Cloud resource reference.",
      input: ItemResourceReferenceFindInputSchema,
      data: ItemResourceReferenceFindDataSchema,
      openWorld: false,
      run: runItemReferenceFind,
    },
    "item.reference.list": {
      title: "List item resource links",
      description: "List the Cloud resource references stored on one readable Space item.",
      input: ItemResourceReferenceListInputSchema,
      data: ItemResourceReferenceListDataSchema,
      openWorld: false,
      run: runItemReferenceList,
    },
    "task.blocker.list": {
      title: "List task blockers",
      description: "List the tasks that currently block one readable task.",
      input: TaskDependencyListInputSchema,
      data: TaskDependencyListDataSchema,
      openWorld: false,
      run: runTaskDependencyList,
    },
    "task.blocks.list": {
      title: "List tasks blocked by a task",
      description: "List the tasks for which one readable task is a blocker.",
      input: TaskDependencyListInputSchema,
      data: TaskDependentListDataSchema,
      openWorld: false,
      run: runTaskDependentList,
    },
    "comment.list": {
      title: "List comments",
      description: "Read comments in one bounded item or recurring-occurrence discussion after checking parent Space access.",
      input: CommentListInputSchema,
      data: CommentListDataSchema,
      openWorld: false,
      run: runCommentList,
    },
    "comment.read": {
      title: "Read comment",
      description: "Read one comment by stable public ID after checking its parent item and Space.",
      input: CommentReadInputSchema,
      data: CommentDataSchema,
      openWorld: false,
      run: runCommentRead,
    },
    "calendar-invitation.preview": {
      title: "Preview calendar invitation",
      description: "Parse a bounded iCalendar invitation and show any linked Space event visible to the actor.",
      input: CalendarInvitationPreviewCapabilityInputSchema,
      data: CalendarInvitationPreviewCapabilityDataSchema,
      openWorld: false,
      run: runCalendarInvitationPreview,
    },
    "calendar-destination.list": {
      title: "List calendar destinations",
      description: "List up to 100 writable Spaces that can receive a calendar invitation.",
      input: CalendarDestinationListInputSchema,
      data: CalendarDestinationListDataSchema,
      openWorld: false,
      run: (_input, context) => calendarDestinationContext(context),
    },
    "calendar-invitation.response.prepare": {
      title: "Prepare calendar response",
      description:
        "Prepare a standards-based response for an invitation already imported into a writable Space. Mail identifiers are opaque correlation values and grant no Space access. Create the draft with mail.draft.create, then commit it.",
      input: CalendarInvitationResponsePrepareInputSchema,
      data: CalendarInvitationResponsePrepareDataSchema,
      openWorld: false,
      run: runCalendarInvitationResponsePrepare,
    },
  },
  actions: {
    "item.reference.add": {
      title: "Link a Cloud resource",
      description: "Link one stable Cloud resource reference to a writable Space item.",
      input: ItemResourceReferenceAddInputSchema,
      data: ItemResourceReferenceDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      run: runItemReferenceAdd,
    },
    "item.reference.remove": {
      title: "Unlink a Cloud resource",
      description: "Remove one Cloud resource reference from a writable Space item, including dangling references.",
      input: ItemResourceReferenceRemoveInputSchema,
      data: ItemResourceReferenceRemoveDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      run: runItemReferenceRemove,
    },
    "task.blocker.add": {
      title: "Add task blocker",
      description: "Mark one task in the same Space as a blocker of another task.",
      input: TaskDependencyInputSchema,
      data: TaskDependencyDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      run: runTaskDependencyAdd,
    },
    "task.blocker.remove": {
      title: "Remove task blocker",
      description: "Remove one blocker relationship between two tasks.",
      input: TaskDependencyInputSchema,
      data: TaskDependencyRemoveDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      run: runTaskDependencyRemove,
    },
    "task.create": {
      title: "Create task",
      description: "Create one task in an explicitly selected writable Space and column.",
      input: TaskCreateInputSchema,
      data: TaskDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      run: runTaskCreate,
    },
    "task.update": {
      title: "Update task",
      description: "Update selected fields of an existing task without converting its item kind.",
      input: TaskUpdateInputSchema,
      data: TaskDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: async (input, context) => {
        const resolved = await requireItem(input.itemId, context, "write");
        if (!resolved.ok) return resolved;
        if (isEvent(resolved.data.item)) return fail(err.badInput("Item is not a task"));
        const relations = await relationReviewDetails(input, resolved.data.internalSpaceId);
        return ok({
          message: `Update task ${resolved.data.item.title}.`,
          details: [
            { label: "Task", value: resolved.data.item.title },
            ...(input.title !== undefined ? [{ label: "Title", value: input.title }] : []),
            ...(input.description !== undefined
              ? [
                  input.description === null
                    ? { label: "Description", value: "Clear description" }
                    : { label: "Description", value: input.description, display: "block" as const },
                ]
              : []),
            ...(input.deadline !== undefined
              ? [
                  input.deadline === null
                    ? { label: "Deadline", value: "Clear deadline" }
                    : { label: "Deadline", value: input.deadline, format: "date-time" as const },
                ]
              : []),
            ...(input.priority !== undefined ? [{ label: "Priority", value: input.priority ?? "No priority" }] : []),
            ...relations,
          ],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
        });
      },
      run: runTaskUpdate,
    },
    "task.set-completed": {
      title: "Set task completion",
      description: "Complete an unblocked task or reopen one task using the Space workflow columns.",
      input: TaskSetCompletedInputSchema,
      data: TaskDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: async (input, context) => {
        const resolved = await requireItem(input.itemId, context, "write");
        if (!resolved.ok) return resolved;
        if (isEvent(resolved.data.item)) return fail(err.badInput("Item is not a task"));
        if (input.completed && resolved.data.item.activeBlockerCount > 0) {
          return fail(err.conflict("Complete all blocking tasks first"));
        }
        return ok({
          message: `${input.completed ? "Complete" : "Reopen"} task ${resolved.data.item.title}.`,
          details: [{ label: "Task", value: resolved.data.item.title }],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
        });
      },
      run: runTaskSetCompleted,
    },
    "event.create": {
      title: "Create calendar event",
      description: "Create one calendar event with an explicit valid time range in a writable Space.",
      input: EventCreateInputSchema,
      data: EventDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      run: runEventCreate,
    },
    "event.update": {
      title: "Update event",
      description: "Update selected event fields without converting its item kind.",
      input: EventUpdateInputSchema,
      data: EventDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: async (input, context) => {
        const resolved = await requireItem(input.itemId, context, "write");
        if (!resolved.ok) return resolved;
        if (!isEvent(resolved.data.item)) return fail(err.badInput("Item is not an event"));
        const [relations, dateConfig] = await Promise.all([
          relationReviewDetails(input, resolved.data.internalSpaceId),
          input.recurrence !== undefined ? capabilityDateConfig() : Promise.resolve(undefined),
        ]);
        const allDay = input.allDay ?? resolved.data.item.allDay;
        const recurrence =
          input.recurrence === undefined
            ? undefined
            : input.recurrence === null
              ? "Does not repeat"
              : `${
                  summarizeRecurrence(input.recurrence, {
                    startsAt: input.startsAt ?? resolved.data.item.startsAt,
                    allDay,
                    dateConfig,
                  }) ?? "Custom recurrence"
                }${
                  input.recurrence.exdate.length > 0
                    ? ` · ${input.recurrence.exdate.length} excluded ${input.recurrence.exdate.length === 1 ? "date" : "dates"}`
                    : ""
                }`;
        return ok({
          message: `Update event ${resolved.data.item.title}.`,
          details: [
            { label: "Event", value: resolved.data.item.title },
            ...(input.title !== undefined ? [{ label: "Title", value: input.title }] : []),
            ...(input.description !== undefined
              ? [
                  input.description === null
                    ? { label: "Description", value: "Clear description" }
                    : { label: "Description", value: input.description, display: "block" as const },
                ]
              : []),
            ...(input.location !== undefined ? [{ label: "Location", value: input.location ?? "Clear location" }] : []),
            ...(input.url !== undefined ? [{ label: "Link", value: input.url ?? "Clear link" }] : []),
            ...(input.startsAt !== undefined
              ? [
                  {
                    label: "Starts",
                    value: input.startsAt,
                    format: allDay ? ("date" as const) : ("date-time" as const),
                  },
                ]
              : []),
            ...(input.endsAt !== undefined
              ? [
                  {
                    label: "Ends",
                    value: input.endsAt,
                    format: allDay ? ("date" as const) : ("date-time" as const),
                  },
                ]
              : []),
            ...(input.allDay !== undefined ? [{ label: "All day", value: input.allDay ? "Yes" : "No" }] : []),
            ...(recurrence !== undefined ? [{ label: "Recurrence", value: recurrence }] : []),
            ...relations,
          ],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
        });
      },
      run: runEventUpdate,
    },
    "event.invitation.prepare": {
      title: "Prepare event invitation",
      description:
        "Prepare an idempotent iCalendar invitation for a writable Space event. Mail identifiers are opaque correlation values and grant no Space access.",
      input: EventInvitationPrepareInputSchema,
      data: EventInvitationPrepareDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      run: runEventInvitationPrepare,
    },
    "event.invitation.commit": {
      title: "Commit event invitation",
      description: "Record that a prepared event invitation was attached to its correlated Mail draft after rechecking Space event access.",
      input: EventInvitationCommitInputSchema,
      data: EventInvitationCommitDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: async (input, context) => {
        const delivery = await spacesService.calendarInvitations.getEventInvitationCommitContext({
          deliveryId: input.deliveryId,
          subject: context.accessSubject,
        });
        if (!delivery.ok) return delivery;
        const item = await requireItemUuid(delivery.data.itemId, context, "write");
        if (!item.ok) return item;
        return ok({
          message: `Record the invitation for ${delivery.data.title} as attached to its Mail draft.`,
          details: [
            { label: "Event", value: delivery.data.title },
            { label: "Draft", value: delivery.data.draftId },
          ],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(item.data.item.spaceId, item.data.item.id) }],
        });
      },
      run: runEventInvitationCommit,
    },
    "item.delete": {
      title: "Delete Space item",
      description: "Permanently delete one task or event from a writable Space.",
      input: ItemDeleteInputSchema,
      data: ItemDeleteDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      review: async (input, context) => {
        const resolved = await requireItem(input.itemId, context, "write");
        if (!resolved.ok) return resolved;
        return ok({
          message: `Permanently delete ${isEvent(resolved.data.item) ? "event" : "task"} ${resolved.data.item.title}.`,
          details: [{ label: isEvent(resolved.data.item) ? "Event" : "Task", value: resolved.data.item.title }],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
        });
      },
      run: runItemDelete,
    },
    "comment.create": {
      title: "Create comment",
      description: "Add a user-authored comment to an item or recurring occurrence in a writable Space.",
      input: CommentCreateInputSchema,
      data: CommentDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      run: runCommentCreate,
    },
    "comment.update": {
      title: "Update comment",
      description: "Update the current user's own comment within 10 minutes in a writable Space.",
      input: CommentUpdateInputSchema,
      data: CommentDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: async (input, context) => {
        if (!context.user) return fail(err.forbidden("Comments require a user-backed actor"));
        const resolved = await resolveComment(input.commentId, context, "write");
        if (!resolved.ok) return resolved;
        if (resolved.data.comment.userId !== context.user.id) return fail(err.forbidden("Only the comment author may edit it"));
        return ok({
          message: `Update your comment on ${resolved.data.item.title}.`,
          details: [
            { label: "Item", value: resolved.data.item.title },
            { label: "Current comment", value: resolved.data.comment.content, display: "block" },
            { label: "Replacement comment", value: input.content, display: "block" },
          ],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, resolved.data.item.id) }],
        });
      },
      run: runCommentUpdate,
    },
    "comment.delete": {
      title: "Delete comment",
      description: "Delete the current user's own comment within the existing ten-minute window.",
      input: CommentDeleteInputSchema,
      data: CommentDeleteDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      review: async (input, context) => {
        if (!context.user) return fail(err.forbidden("Comments require a user-backed actor"));
        const resolved = await resolveComment(input.commentId, context, "write");
        if (!resolved.ok) return resolved;
        if (resolved.data.comment.userId !== context.user.id) return fail(err.forbidden("Only the comment author may delete it"));
        return ok({
          message: `Delete your comment on ${resolved.data.item.title}.`,
          details: [
            { label: "Item", value: resolved.data.item.title },
            { label: "Comment", value: resolved.data.comment.content, display: "block" },
          ],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, resolved.data.item.id) }],
        });
      },
      run: runCommentDelete,
    },
    "calendar-invitation.import": {
      title: "Import calendar invitation",
      description:
        "Idempotently create, update, or cancel the matching event in an explicitly selected writable Space. Mail identifiers are opaque correlation values and grant no Space access.",
      input: CalendarInvitationImportCapabilityInputSchema,
      data: CalendarInvitationImportCapabilityDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      review: async (input, context) => {
        if (!context.user) return fail(err.forbidden("Importing an invitation requires a user-backed actor"));
        const access = await requireSpace(input.spaceId, context, "write");
        if (!access.ok) return access;
        const preview = await spacesService.calendarInvitations.previewCalendarInvitation(input);
        if (!preview.ok) return preview;
        if (preview.data.existing && preview.data.existing.spaceId !== access.data.internalId) {
          return fail(err.conflict("This calendar event is already linked to another Space"));
        }
        const decision = spacesService.calendarInvitations.decideCalendarImport({
          existing: preview.data.existing,
          invitation: preview.data.invitation,
        });
        if (decision === "reject_cancellation") return fail(err.badInput("Cannot import a cancellation without an existing event"));
        const consequence = decision === "create" ? "Create" : decision === "unchanged" ? "Keep" : "Update";
        return ok({
          message: `${consequence} calendar event ${preview.data.invitation.title} in ${access.data.space.name}.`,
          details: [
            { label: "Space", value: access.data.space.name },
            { label: "Event", value: preview.data.invitation.title },
            { label: "Method", value: preview.data.invitation.method },
            { label: "Starts", value: preview.data.invitation.startsAt, format: "date-time" },
            { label: "Ends", value: preview.data.invitation.endsAt, format: "date-time" },
          ],
          ...(preview.data.existing ? { links: [{ rel: "open" as const, href: preview.data.existing.href }] } : {}),
        });
      },
      run: runCalendarInvitationImport,
    },
    "calendar-invitation.response.commit": {
      title: "Commit calendar response draft",
      description: "Record the correlated Mail draft after mail.draft.create succeeds and recheck access to the linked Space event.",
      input: CalendarInvitationResponseCommitCapabilityInputSchema,
      data: CalendarInvitationResponseCommitCapabilityDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: async (input, context) => {
        const source = await spacesService.calendarInvitations.getCalendarResponseCommitContext({
          input,
          subject: context.accessSubject,
        });
        if (!source.ok) return source;
        const item = await requireItemUuid(source.data.itemId, context, "write");
        if (!item.ok) return item;
        return ok({
          message: `Record the ${input.participationStatus} calendar response for ${source.data.title}.`,
          details: [
            { label: "Event", value: source.data.title },
            { label: "Response", value: input.participationStatus },
            { label: "Draft", value: input.draftId },
          ],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(item.data.item.spaceId, item.data.item.id) }],
        });
      },
      run: runCalendarInvitationResponseCommit,
    },
  },
});
