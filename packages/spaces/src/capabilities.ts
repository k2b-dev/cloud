import { createHash } from "node:crypto";
import { err, fail, i18n, ok, type Paginated, type Result, type ServiceError } from "@k2b/stdlib";
import {
  CAPABILITY_MAX_RESULT_BYTES,
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
} from "@k2b/cloud/contracts";
import { hasPermission, type PermissionLevel } from "@k2b/cloud/server";
import { type AuditActor, audit } from "@k2b/cloud/services";
import { get as settingsGet } from "@k2b/cloud/services/settings";
import { normalizeTimeZone } from "@k2b/cloud/shared";
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
  ItemTagsSetInputSchema,
  SpaceAssigneeListDataSchema,
  SpaceAssigneeListInputSchema,
  SpaceBrowseDataSchema,
  SpaceDetailDataSchema,
  SpaceListDataSchema,
  SpaceListInputSchema,
  SpaceReadInputSchema,
  TaskChecklistCreateInputSchema,
  TaskChecklistDataSchema,
  TaskChecklistDeleteDataSchema,
  TaskChecklistDeleteInputSchema,
  TaskChecklistListDataSchema,
  TaskChecklistListInputSchema,
  TaskChecklistUpdateInputSchema,
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
import { spacesCapabilityPresentation } from "./capability-presentation";
import {
  AgendaCursorError,
  decodeWorkCursor,
  EventAgendaDataSchema,
  EventAgendaInputSchema,
  TaskFocusDataSchema,
  TaskFocusInputSchema,
} from "./capability-work-contracts";
import { boundedWorkPage, runEventAgenda, runTaskFocus } from "./capability-work-queries";
import type { MutationResult, SpaceComment, SpaceItem, SpaceItemAttachment } from "./contracts";
import { summarizeRecurrence } from "./presentation/recurrence";
import { buildSpaceItemHref } from "./routes";
import type { ItemAcrossKind, SpaceWithPermission } from "./service";
import { spacesService } from "./service";
import { isSpaceResourceId, resolveSpaceApiKeyPermission, SPACE_RESOURCE_TYPE, SPACES_APP_ID } from "./service/access";
import { localizeSpacesError, type SpacesMessages, spacesMessages } from "./service/messages";
import { spacesPublicResources } from "./service/public-resources";
import { CalendarReadLimitError } from "./service/recurrence";
import * as taskWork from "./service/task-work";
import { ClaimTaskSchema, ProgressTaskSchema, ReleaseTaskSchema, TaskWorkSchema } from "./work-contracts";

const encodeCursor = (page: number): string => Buffer.from(JSON.stringify({ v: 1, page }), "utf8").toString("base64url");

const stableUuid = (value: string): string => {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const capabilityActorKey = (context: CapabilityExecutionContext): string =>
  context.accessSubject.type === "user"
    ? `user:${context.accessSubject.userId}:${context.accessSubject.delegatedByServiceAccountId ?? "direct"}`
    : `service_account:${context.accessSubject.serviceAccountId}`;
const EVENT_CREATE_ONCE_ACTION_ID = "spaces.event.create-once";

const capabilityFail = (context: CapabilityExecutionContext, error: ServiceError, messageKey?: keyof SpacesMessages) => {
  if (!messageKey) return fail(localizeSpacesError(error, context.locale));
  const message = spacesMessages(context.locale)[messageKey];
  if (typeof message !== "string") throw new Error(`Spaces capability error message ${messageKey} must be static`);
  return fail({ ...error, message });
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

const spaceApprovalScope = (spaceId: string): string => `space:${spaceId}`;
const itemApprovalScope = (itemId: string): string => `item:${itemId}`;

const capabilityDateConfig = async (context: CapabilityExecutionContext) => ({
  timeZone: normalizeTimeZone(String((await settingsGet<string>("app.timezone")) || "").trim(), "UTC"),
  locale: context.locale,
  firstDayOfWeek: 1 as const,
});

const relationReviewDetails = async (
  input: { assigneeIds?: string[]; tagIds?: string[] },
  internalSpaceId: string,
  context: CapabilityExecutionContext,
): Promise<ReviewDetails> => {
  const t = spacesMessages(context.locale);
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
            label: t.assignees,
            value:
              i18n.formatList(
                input.assigneeIds.map((id) => userNames.get(id) ?? id),
                context.locale,
              ) || t.none,
          },
        ]
      : []),
    ...(input.tagIds
      ? [
          {
            label: t.tags,
            value:
              i18n.formatList(
                input.tagIds.map((id) => tagNames.get(id) ?? id),
                context.locale,
              ) || t.none,
          },
        ]
      : []),
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

export const decodeSpacesCapabilityCursor = (cursor: string | undefined, locale?: string): Result<number> => {
  if (!cursor) return ok(1);
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; page?: unknown };
    return value.v === 1 && Number.isInteger(value.page) && Number(value.page) >= 1
      ? ok(Number(value.page))
      : fail(localizeSpacesError(err.badInput("Invalid cursor"), locale));
  } catch {
    return fail(localizeSpacesError(err.badInput("Invalid cursor"), locale));
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
    return context.accessSubject.type === "user" ? ok(null) : capabilityFail(context, err.forbidden("Access denied"), "accessDenied");
  }
  const account = context.actor.serviceAccount;
  if (account.kind === "user_delegated") {
    return context.accessSubject.type === "user" && context.user
      ? ok(null)
      : capabilityFail(context, err.forbidden("Access denied"), "accessDenied");
  }
  if (
    account.appId !== SPACES_APP_ID ||
    account.resourceType !== SPACE_RESOURCE_TYPE ||
    !isSpaceResourceId(account.resourceId) ||
    context.accessSubject.type !== "service_account" ||
    !hasPermission(permissionFromScopes(context.actor.scopes), required)
  ) {
    return capabilityFail(context, err.forbidden("Access denied"), "accessDenied");
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
  if (scope.data && scope.data !== spaceId) return capabilityFail(context, err.notFound("Space"), "spaceNotFound");
  const space = await spacesService.space.get({ id: spaceId });
  if (!space) return capabilityFail(context, err.notFound("Space"), "spaceNotFound");
  const granted = await spacesService.space.permission.get({ spaceId, subject: context.accessSubject });
  const permission = granted === "none" ? "none" : effectivePermission(granted, context);
  if (!hasPermission(permission, required)) return capabilityFail(context, err.notFound("Space"), "spaceNotFound");
  const [publicSpace] = await spacesPublicResources.projectSpaces([space]);
  return publicSpace
    ? ok({ space: publicSpace, internalId: spaceId, permission })
    : capabilityFail(context, err.notFound("Space"), "spaceNotFound");
};

const requireSpace = async (shortId: string, context: CapabilityExecutionContext, required: PermissionLevel = "read") => {
  const spaceId = await spacesPublicResources.resolvePublicId("spaces", shortId);
  return spaceId ? requireSpaceUuid(spaceId, context, required) : capabilityFail(context, err.notFound("Space"), "spaceNotFound");
};

const requireItemUuid = async (internalId: string, context: CapabilityExecutionContext, required: PermissionLevel = "read") => {
  const item = await spacesService.item.get({ id: internalId });
  if (!item) return capabilityFail(context, err.notFound("Item"), "itemNotFound");
  const access = await requireSpaceUuid(item.spaceId, context, required);
  if (!access.ok) return capabilityFail(context, err.notFound("Item"), "itemNotFound");
  const [publicItem] = await spacesPublicResources.projectItems([item]);
  return publicItem
    ? ok({ item: publicItem, internalId, internalSpaceId: item.spaceId, permission: access.data.permission })
    : capabilityFail(context, err.notFound("Item"), "itemNotFound");
};

const requireItem = async (itemId: string, context: CapabilityExecutionContext, required: PermissionLevel = "read") => {
  const internalId = await spacesPublicResources.resolvePublicId("items", itemId);
  return internalId ? requireItemUuid(internalId, context, required) : capabilityFail(context, err.notFound("Item"), "itemNotFound");
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

const mapAttachment = (item: SpaceItem, attachment: SpaceItemAttachment) => {
  const contentHref = `/api/spaces/${encodeURIComponent(item.spaceId)}/items/${encodeURIComponent(item.id)}/attachments/${encodeURIComponent(attachment.id)}/content`;
  return {
    ...attachment,
    links: [
      ...(attachment.kind === "image" ? [{ rel: "preview" as const, href: contentHref }] : []),
      { rel: "download" as const, href: `${contentHref}?download=true` },
    ],
  };
};

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

const spaceRef = (space: { id: string; name: string; description?: string | null }) => ({
  type: "spaces.space" as const,
  id: space.id,
  title: space.name,
  ...(space.description ? { preview: space.description } : {}),
  icon: "ti ti-layout-kanban",
});
const itemRef = (item: { id: string; title: string; description?: string | null }, kind: "task" | "event") => ({
  type: "spaces.item" as const,
  id: item.id,
  title: item.title,
  ...(item.description ? { preview: item.description } : {}),
  icon: kind === "event" ? "ti ti-calendar-event" : "ti ti-checkbox",
});
const commentRef = (
  comment: Pick<SpaceComment, "id" | "userName">,
  item: Pick<SpaceItem, "title">,
  context: CapabilityExecutionContext,
) => ({
  type: "spaces.comment" as const,
  id: comment.id,
  title: spacesMessages(context.locale).commentOn({ title: item.title }),
  ...(comment.userName ? { preview: comment.userName } : {}),
  icon: "ti ti-message",
});

const runSpaceSearch = async (input: UniversalSearchInput, context: CapabilityExecutionContext) => {
  const t = spacesMessages(context.locale);
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
    metadata: [{ label: t.type, value: t.space }],
    links: [{ rel: "open", href: `/app/spaces/${entry.id}` }],
  }));
  return ok({ data });
};

const runItemSearch = async (
  input: UniversalSearchInput,
  context: CapabilityExecutionContext,
  requiredLevel: "read" | "write" = "read",
) => {
  const t = spacesMessages(context.locale);
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
        { label: t.type, value: t.spaceItem },
        { label: t.space, value: space.name },
        { label: t.itemKind, value: isEvent(item) ? t.event : t.task },
      ],
      links: [{ rel: "open", href: buildSpaceItemHref(space.id, item.id) }],
    };
  });
  return ok({ data });
};

const runItemReferenceFind = async (input: z.infer<typeof ItemResourceReferenceFindInputSchema>, context: CapabilityExecutionContext) => {
  const t = spacesMessages(context.locale);
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
        { label: t.space, value: space.name },
        { label: t.itemKind, value: isEvent(item) ? t.event : t.task },
      ],
      links: [{ rel: "open", href: buildSpaceItemHref(space.id, item.id) }],
    };
  });
  return ok({ data: { items: data, truncated } });
};

const runSpaceList = async (input: z.infer<typeof SpaceListInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeSpacesCapabilityCursor(input.cursor, context.locale);
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
    descriptionTruncated: false,
    ref: { type: "spaces.space" as const, id: space.id },
    links: [{ rel: "open" as const, href: `/app/spaces/${space.id}` }],
  }));
  const result = pageResult(page, data, publicSpaces.map(spaceRef));
  if (result.ok && Buffer.byteLength(JSON.stringify(result.data), "utf8") > CAPABILITY_MAX_RESULT_BYTES) {
    result.data.refs = publicSpaces.map((space) => ({ type: "spaces.space", id: space.id }));
    while (Buffer.byteLength(JSON.stringify(result.data), "utf8") > CAPABILITY_MAX_RESULT_BYTES) {
      let shortened = false;
      for (const space of data) {
        if (!space.description) continue;
        space.description = truncateText(space.description, Math.floor(Buffer.byteLength(space.description) / 2)).text;
        space.descriptionTruncated = true;
        shortened = true;
      }
      if (!shortened) return fail(err.badInput(spacesMessages(context.locale).smallerPageRequired));
    }
  }
  return result;
};

const runSpaceRead = async (input: z.infer<typeof SpaceReadInputSchema>, context: CapabilityExecutionContext) => {
  const access = await requireSpace(input.id, context);
  if (!access.ok) return access;
  const detail = await spacesService.space.getDetail({ id: access.data.internalId });
  if (!detail) return capabilityFail(context, err.notFound("Space"), "spaceNotFound");
  const [publicDetail] = await spacesPublicResources.projectSpaces([detail]);
  const [columns, tags] = await Promise.all([
    spacesPublicResources.projectColumns(detail.columns),
    spacesPublicResources.projectTags(detail.tags),
  ]);
  if (!publicDetail) return capabilityFail(context, err.notFound("Space"), "spaceNotFound");
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
    summary: boundedCapabilitySummary(spacesMessages(context.locale).readSpace({ name: publicDetail.name })),
    refs: [spaceRef(publicDetail)],
    links: [{ rel: "open" as const, href: `/app/spaces/${publicDetail.id}` }],
  });
};

const runSpaceBrowse = async (input: z.infer<typeof SpaceListInputSchema>, context: CapabilityExecutionContext) => {
  const result = await runSpaceList(input, context);
  return result.ok
    ? ok({
        ...result.data,
        data: result.data.data.map(({ id, ref, name, description, descriptionTruncated, permission, links }) => ({
          id,
          ref,
          name,
          description,
          descriptionTruncated,
          permission,
          links,
        })),
      })
    : result;
};

const workQueryContext = async (
  input: { spaceId?: string; cursor?: string; assignedTo: string },
  context: CapabilityExecutionContext,
  agenda = false,
) => {
  if (!agenda) {
    try {
      decodeWorkCursor(input.cursor);
    } catch {
      return fail(localizeSpacesError(err.badInput("Invalid cursor"), context.locale));
    }
  }
  if (input.assignedTo === "me" && !context.user)
    return capabilityFail(context, err.forbidden("The me filter requires a user-backed actor"), "meFilterNeedsUser");
  const scope = scopedSpaceId(context, "read");
  if (!scope.ok) return scope;
  const space = input.spaceId ? await requireSpace(input.spaceId, context) : null;
  if (space && !space.ok) return space;
  return ok({
    subject: context.accessSubject,
    boundSpaceId: scope.data,
    ...(space?.ok ? { spaceId: space.data.internalId } : {}),
    dateConfig: await capabilityDateConfig(context),
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
  const cursor = decodeSpacesCapabilityCursor(input.cursor, context.locale);
  if (!cursor.ok) return cursor;
  if (input.assignedTo === "me" && !context.user)
    return capabilityFail(context, err.forbidden("The me filter requires a user-backed actor"), "meFilterNeedsUser");
  const access = await requireSpace(input.spaceId, context);
  if (!access.ok) return access;
  const [columnIds, tagIds] = await Promise.all([
    spacesPublicResources.resolveSpacePublicIds("columns", access.data.internalId, input.columnIds ?? []),
    spacesPublicResources.resolveSpacePublicIds("tags", access.data.internalId, input.tagIds ?? []),
  ]);
  if (!columnIds)
    return capabilityFail(context, err.badInput("Unknown columnIds value; use a column ID returned by Read space"), "unknownColumnIds");
  if (!tagIds) return capabilityFail(context, err.badInput("Unknown tagIds value; use a tag ID returned by Read space"), "unknownTagIds");
  const page = await spacesService.item.listFiltered({
    spaceId: access.data.internalId,
    currentUserId: context.user?.id,
    ...(input.deadlineFilter !== "all" ? { dateConfig: await capabilityDateConfig(context) } : {}),
    filter: {
      type: kind,
      status: input.status,
      activity: input.activity,
      priority: input.priority,
      columnIds,
      tagIds,
      assigneeIds: input.assigneeIds,
      assignedTo: input.assignedTo,
      deadlineFilter: input.deadlineFilter,
      search: input.query,
      sort: input.sort,
      sortDesc: input.sortDesc,
      groupBy: "none",
      page: cursor.data,
      pageSize: input.limit,
    },
  });
  const [publicItems, columns] = await Promise.all([
    spacesPublicResources.projectItems(page.items),
    spacesService.column.list({ spaceId: access.data.internalId, pagination: { page: 1, perPage: 100 } }),
  ]);
  const columnNames = new Map(columns.items.map((column) => [column.id, column.name]));
  const itemColumnNames = new Map(publicItems.map((item, index) => [item.id, columnNames.get(page.items[index]!.columnId) ?? null]));
  const items = (
    kind === "event" ? publicItems.filter(isEvent).map(mapEventSummary) : publicItems.filter((item) => !isEvent(item)).map(mapTaskSummary)
  ).map((item) => ({
    ...item,
    columnName: itemColumnNames.get(item.id) ?? null,
    ref: { type: "spaces.item" as const, id: item.id },
    links: [{ rel: "open" as const, href: buildSpaceItemHref(item.spaceId, item.id) }],
  }));
  const result = pageResult(
    { items: page.items, page: page.page, perPage: page.pageSize, total: page.total, hasNext: page.page < page.totalPages },
    items,
    items.map((item) => ({ type: "spaces.item" as const, id: item.id })),
  );
  // Keep the existing page cursor and every row. Optional previews and relation
  // snapshots may shrink further under JSON escaping; item.read remains canonical.
  if (result.ok) {
    while (Buffer.byteLength(JSON.stringify(result.data), "utf8") > CAPABILITY_MAX_RESULT_BYTES) {
      let shortened = false;
      for (const item of items) {
        if (item.descriptionPreview) {
          item.descriptionPreview = truncateText(item.descriptionPreview, Math.floor(Buffer.byteLength(item.descriptionPreview) / 2)).text;
          item.descriptionTruncated = true;
          shortened = true;
        }
        if (item.assignees.length || item.tags.length) {
          item.assignees = item.assignees.slice(0, -1);
          item.tags = item.tags.slice(0, -1);
          item.relationsTruncated = true;
          shortened = true;
        }
        if (item.kind === "event") {
          if (item.location) {
            item.location = truncateText(item.location, Math.floor(Buffer.byteLength(item.location) / 2)).text;
            item.locationTruncated = true;
            shortened = true;
          }
          if (item.url) {
            item.url = truncateText(item.url, Math.floor(Buffer.byteLength(item.url) / 2)).text;
            item.urlTruncated = true;
            shortened = true;
          }
        }
      }
      if (!shortened) return fail(err.badInput(spacesMessages(context.locale).smallerPageRequired));
    }
  }
  return result;
};

const runItemRead = async (input: z.infer<typeof ItemReadInputSchema>, context: CapabilityExecutionContext) => {
  const resolved = await requireItem(input.id, context);
  if (!resolved.ok) return resolved;
  const data = isEvent(resolved.data.item)
    ? mapEvent(resolved.data.item)
    : {
        ...mapTask(resolved.data.item),
        attachments: (await spacesService.item.attachments.list({ itemId: resolved.data.internalId })).map((attachment) =>
          mapAttachment(resolved.data.item, attachment),
        ),
      };
  return ok({
    data,
    summary: boundedCapabilitySummary(
      spacesMessages(context.locale).readItem({
        kind: data.kind === "event" ? spacesMessages(context.locale).eventSummaryKind : spacesMessages(context.locale).taskSummaryKind,
        title: data.title,
      }),
    ),
    refs: [itemRef(data, data.kind)],
    links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, resolved.data.item.id) }],
  });
};

const runCommentList = async (input: z.infer<typeof CommentListInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeSpacesCapabilityCursor(input.cursor, context.locale);
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
  const data = (await spacesPublicResources.projectComments(page.items)).map((comment) => ({
    ...mapCommentSummary(comment),
    ref: { type: "spaces.comment" as const, id: comment.id },
  }));
  return pageResult(
    page,
    data,
    data.map((comment) => commentRef(comment, resolved.data.item, context)),
    [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, resolved.data.item.id) }],
  );
};

const resolveComment = async (commentId: string, context: CapabilityExecutionContext, required: PermissionLevel = "read") => {
  const internalId = await spacesPublicResources.resolvePublicId("comments", commentId);
  if (!internalId) return capabilityFail(context, err.notFound("Comment"), "commentNotFound");
  const comment = await spacesService.comment.get({ id: internalId, viewerUserId: context.user?.id ?? null });
  if (!comment) return capabilityFail(context, err.notFound("Comment"), "commentNotFound");
  const item = await requireItemUuid(comment.itemId, context, required);
  const [publicComment] = await spacesPublicResources.projectComments([comment]);
  return item.ok && publicComment
    ? ok({ comment: publicComment, internalId, item: item.data.item, internalItemId: comment.itemId })
    : capabilityFail(context, err.notFound("Comment"), "commentNotFound");
};

const runCommentRead = async (input: z.infer<typeof CommentReadInputSchema>, context: CapabilityExecutionContext) => {
  const resolved = await resolveComment(input.id, context);
  if (!resolved.ok) return resolved;
  return ok({
    data: mapComment(resolved.data.comment),
    summary: boundedCapabilitySummary(spacesMessages(context.locale).readComment({ title: resolved.data.item.title })),
    refs: [
      commentRef(resolved.data.comment, resolved.data.item, context),
      itemRef(resolved.data.item, isEvent(resolved.data.item) ? "event" : "task"),
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

const spaceActivityActor = (context: CapabilityExecutionContext) =>
  context.actor.kind === "user"
    ? ({ kind: "user", id: context.actor.user.id } as const)
    : ({ kind: "service_account", id: context.actor.serviceAccount.id } as const);

const actionAudit = (context: CapabilityExecutionContext, actionId: string, targetType: string, targetId: string) => ({
  action: `spaces.capability.${actionId}`,
  actor: capabilityAuditActor(context),
  target: { type: targetType, id: targetId },
  metadata: { capability: `spaces.${actionId}` },
});

const audited = async <T>(
  params: ReturnType<typeof actionAudit>,
  operation: () => Promise<CapabilityInvocationResult<T>>,
  replayed: boolean | (() => boolean) = false,
): Promise<CapabilityInvocationResult<T>> => {
  const result = await operation();
  if (!result.ok) return audit.recordResult({ ...params, result });
  const wasReplayed = typeof replayed === "function" ? replayed() : replayed;
  return wasReplayed
    ? audit.recordResult({ ...params, metadata: { ...params.metadata, replayed: true }, result })
    : audit.recordResultAfterSideEffect({ ...params, result });
};

const boundedCapabilitySummary = (value: string): string => {
  let summary = "";
  for (const character of value.trim()) {
    if (`${summary}${character}`.length > 500) break;
    summary += character;
  }
  return summary;
};

const participationStatusLabel = (t: SpacesMessages, status: "accepted" | "declined" | "tentative") => t[status];
const participationResponseLabel = (t: SpacesMessages, status: "accepted" | "declined" | "tentative") =>
  status === "accepted" ? t.acceptanceResponse : status === "declined" ? t.declinedResponse : t.tentativeResponse;
const formatSummaryList = (values: string[], locale?: string): string => i18n.formatList(values, locale);

const tagSetSummary = (before: SpaceItem, after: SpaceItem, context: CapabilityExecutionContext): string => {
  const t = spacesMessages(context.locale);
  const beforeIds = new Set((before.tags ?? []).map((tag) => tag.id));
  const afterIds = new Set((after.tags ?? []).map((tag) => tag.id));
  const added = (after.tags ?? []).filter((tag) => !beforeIds.has(tag.id)).map((tag) => `#${tag.name}`);
  const removed = (before.tags ?? []).filter((tag) => !afterIds.has(tag.id)).map((tag) => `#${tag.name}`);
  if (added.length > 0 && removed.length > 0) {
    return t.tagsAddedAndRemoved({
      added: formatSummaryList(added, context.locale),
      removed: formatSummaryList(removed, context.locale),
      title: after.title,
    });
  }
  if (added.length > 0) return t.tagsAdded({ tags: formatSummaryList(added, context.locale), title: after.title });
  if (removed.length > 0) return t.tagsRemoved({ tags: formatSummaryList(removed, context.locale), title: after.title });
  return t.tagsUnchanged({ title: after.title });
};

const ITEM_SUMMARY_FIELDS: Record<string, string> = {
  title: "title",
  description: "description",
  deadline: "deadline",
  estimatedDurationMinutes: "estimate",
  priority: "priority",
  assigneeIds: "assignees",
  tagIds: "tags",
  location: "location",
  url: "link",
  startsAt: "time",
  endsAt: "time",
  allDay: "all-day setting",
  recurrence: "recurrence",
};

const itemUpdateSummary = (
  before: SpaceItem,
  after: SpaceItem,
  input: Record<string, unknown>,
  context: CapabilityExecutionContext,
): string => {
  const t = spacesMessages(context.locale);
  const fieldNames: Record<string, string> = {
    title: t.title,
    description: t.description,
    deadline: t.deadline,
    estimate: t.fieldEstimate,
    priority: t.priority,
    assignees: t.fieldAssignees,
    tags: t.tags,
    location: t.location,
    link: t.link,
    time: t.starts,
    "all-day setting": t.fieldAllDay,
    recurrence: t.recurrence,
  };
  const fields = [
    ...new Set(
      Object.keys(input)
        .filter((field) => field !== "itemId")
        .map((field) => ITEM_SUMMARY_FIELDS[field] ?? field),
    ),
  ];
  if (fields.length === 1 && fields[0] === "title" && before.title !== after.title) {
    return t.renamedItem({ before: before.title, after: after.title });
  }
  if (fields.length === 1 && fields[0] === "time") return t.movedItemTime({ title: after.title });
  const localizedFields = fields.map((field) => fieldNames[field] ?? field);
  return fields.length === 1
    ? t.changedItemField({ field: localizedFields[0]!, title: after.title })
    : t.changedItemFields({ fields: formatSummaryList(localizedFields, context.locale), title: after.title });
};

const mutationError = <T>(result: Exclude<MutationResult<T>, { ok: true }>, context: CapabilityExecutionContext) => {
  const error =
    result.status === 403
      ? err.forbidden(result.error)
      : result.status === 404
        ? { code: "NOT_FOUND" as const, message: result.error, status: 404 as const }
        : result.status === 409
          ? err.conflict(result.error)
          : result.status === 500
            ? err.internal(result.error)
            : err.badInput(result.error);
  return fail(localizeSpacesError(error, context.locale));
};

const itemMutationResult = async (
  result: MutationResult<SpaceItem>,
  summary: (item: SpaceItem) => string,
  context: CapabilityExecutionContext,
) => {
  if (!result.ok) return mutationError(result, context);
  const [item] = await spacesPublicResources.projectItems([result.data]);
  if (!item) return capabilityFail(context, err.internal("Failed to project Space item"), "operationFailed");
  return ok({
    data: mapItem(item),
    summary: boundedCapabilitySummary(summary(item)),
    refs: [{ type: "spaces.space" as const, id: item.spaceId }, itemRef(item, isEvent(item) ? "event" : "task")],
    links: [{ rel: "open" as const, href: buildSpaceItemHref(item.spaceId, item.id) }],
  });
};

const runItemReferenceList = async (input: z.infer<typeof ItemResourceReferenceListInputSchema>, context: CapabilityExecutionContext) => {
  const resolved = await requireItem(input.itemId, context, "read");
  if (!resolved.ok) return resolved;
  const data = await spacesService.item.references.list({ itemId: resolved.data.internalId });
  return ok({
    data,
    refs: [
      itemRef(resolved.data.item, isEvent(resolved.data.item) ? "event" : "task"),
      ...data.map((reference) => ({ ...reference.ref, title: reference.label })),
    ],
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
    if (!data)
      return capabilityFail(context, err.conflict("Space item already has the maximum number of linked resources"), "maxLinkedResources");
    return ok({
      data,
      summary: boundedCapabilitySummary(
        spacesMessages(context.locale).linkedResource({ resource: input.reference.label, item: resolved.data.item.title }),
      ),
      refs: [
        itemRef(resolved.data.item, isEvent(resolved.data.item) ? "event" : "task"),
        { ...input.reference.ref, title: input.reference.label },
      ],
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
      summary: boundedCapabilitySummary(
        deleted
          ? spacesMessages(context.locale).removedResource({ item: resolved.data.item.title })
          : spacesMessages(context.locale).noMatchingResource({ item: resolved.data.item.title }),
      ),
      refs: [itemRef(resolved.data.item, isEvent(resolved.data.item) ? "event" : "task"), input.ref],
      links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
    });
  });

const runItemTagsSet = async (input: z.infer<typeof ItemTagsSetInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "item.tags.set", "space_item", input.itemId), async () => {
    const resolved = await requireItem(input.itemId, context, "write");
    if (!resolved.ok) return resolved;
    const tagIds = await spacesPublicResources.resolveSpacePublicIds("tags", resolved.data.internalSpaceId, input.tagIds);
    if (!tagIds) return capabilityFail(context, err.badInput("Unknown Space tag"), "unknownSpaceTag");
    return itemMutationResult(
      await spacesService.item.update({ id: resolved.data.internalId, data: { tagIds }, actor: spaceActivityActor(context) }),
      (item) => tagSetSummary(resolved.data.item, item, context),
      context,
    );
  });

const requireChecklistTask = async (itemId: string, context: CapabilityExecutionContext, permission: "read" | "write") => {
  const result = await requireItem(itemId, context, permission);
  if (!result.ok) return result;
  return isEvent(result.data.item) ? capabilityFail(context, err.badInput("Item is not a task"), "itemNotTask") : result;
};

const reviewChecklist = async (
  input: { itemId: string; entryId?: string; label?: string; completed?: boolean },
  context: CapabilityExecutionContext,
) => {
  const task = await requireChecklistTask(input.itemId, context, "write");
  if (!task.ok) return task;
  const t = spacesMessages(context.locale);
  const entry = input.entryId
    ? (await spacesService.item.checklist.list({ itemId: task.data.internalId })).find((entry) => entry.id === input.entryId)
    : null;
  if (input.entryId && !entry) return fail(localizeSpacesError(err.notFound("Checklist entry"), context.locale));
  return ok({
    message: t.reviewChecklistChange({ title: task.data.item.title }),
    details: [
      ...(input.entryId ? [{ label: t.reference, value: input.entryId }] : []),
      ...(entry
        ? [
            { label: t.checklistEntry, value: entry.label },
            { label: t.checklistCompleted, value: entry.completed ? t.yes : t.no },
          ]
        : []),
      ...(input.label ? [{ label: t.checklistEntry, value: input.label }] : []),
      ...(input.completed !== undefined ? [{ label: t.checklistCompleted, value: input.completed ? t.yes : t.no }] : []),
    ],
    approvalScope: spaceApprovalScope(task.data.item.spaceId),
    links: [{ rel: "open" as const, href: buildSpaceItemHref(task.data.item.spaceId, input.itemId) }],
  });
};

const runChecklistList = async (input: z.infer<typeof TaskChecklistListInputSchema>, context: CapabilityExecutionContext) => {
  let offset: number;
  try {
    offset = decodeWorkCursor(input.cursor);
  } catch {
    return fail(localizeSpacesError(err.badInput("Invalid cursor"), context.locale));
  }
  const task = await requireChecklistTask(input.itemId, context, "read");
  if (!task.ok) return task;
  const entries = await spacesService.item.checklist.list({ itemId: task.data.internalId });
  return ok(
    boundedWorkPage(
      entries.slice(offset, offset + input.limit).map(({ id, label, completed }) => ({ id, label, completed })),
      offset,
      entries.length - offset,
    ),
  );
};

const runChecklistCreate = async (input: z.infer<typeof TaskChecklistCreateInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "task.checklist.create", "space_item", input.itemId), async () => {
    const task = await requireChecklistTask(input.itemId, context, "write");
    if (!task.ok) return task;
    const result = await spacesService.item.checklist.create({
      itemId: task.data.internalId,
      data: { label: input.label },
      actor: spaceActivityActor(context),
    });
    return result.ok
      ? ok({
          data: { id: result.data.id, label: result.data.label, completed: result.data.completed },
          refs: [itemRef(task.data.item, "task")],
        })
      : mutationError(result, context);
  });

const runChecklistUpdate = async (input: z.infer<typeof TaskChecklistUpdateInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "task.checklist.update", "space_item", input.itemId), async () => {
    const task = await requireChecklistTask(input.itemId, context, "write");
    if (!task.ok) return task;
    const id = await spacesPublicResources.resolvePublicId("checklist", input.entryId);
    if (!id) return fail(localizeSpacesError(err.notFound("Checklist entry"), context.locale));
    const result = await spacesService.item.checklist.update({
      itemId: task.data.internalId,
      id,
      data: { label: input.label, completed: input.completed },
      actor: spaceActivityActor(context),
    });
    return result.ok
      ? ok({
          data: { id: result.data.id, label: result.data.label, completed: result.data.completed },
          refs: [itemRef(task.data.item, "task")],
        })
      : mutationError(result, context);
  });

const runChecklistDelete = async (input: z.infer<typeof TaskChecklistDeleteInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "task.checklist.delete", "space_item", input.itemId), async () => {
    const task = await requireChecklistTask(input.itemId, context, "write");
    if (!task.ok) return task;
    const id = await spacesPublicResources.resolvePublicId("checklist", input.entryId);
    if (!id) return fail(localizeSpacesError(err.notFound("Checklist entry"), context.locale));
    const result = await spacesService.item.checklist.remove({ itemId: task.data.internalId, id, actor: spaceActivityActor(context) });
    return result.ok
      ? ok({ data: { id: input.entryId, deleted: true as const }, refs: [itemRef(task.data.item, "task")] })
      : mutationError(result, context);
  });

const runTaskDependencyList = async (input: z.infer<typeof TaskDependencyListInputSchema>, context: CapabilityExecutionContext) => {
  const resolved = await requireItem(input.itemId, context, "read");
  if (!resolved.ok) return resolved;
  if (isEvent(resolved.data.item)) return capabilityFail(context, err.badInput("Item is not a task"), "itemNotTask");
  const dependencies = await spacesPublicResources.projectTaskDependencies(
    await spacesService.item.dependencies.list({ itemId: resolved.data.internalId }),
  );
  return ok({
    data: dependencies.map((dependency) => ({
      ...dependency,
      blocker: { ...dependency.blocker, ref: { type: "spaces.item" as const, id: dependency.blocker.id } },
    })),
    refs: [itemRef(resolved.data.item, "task")],
    links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
  });
};

const runTaskDependentList = async (input: z.infer<typeof TaskDependencyListInputSchema>, context: CapabilityExecutionContext) => {
  const resolved = await requireItem(input.itemId, context, "read");
  if (!resolved.ok) return resolved;
  if (isEvent(resolved.data.item)) return capabilityFail(context, err.badInput("Item is not a task"), "itemNotTask");
  const dependents = await spacesPublicResources.projectTaskDependents(
    await spacesService.item.dependencies.listBlocks({ blockerItemId: resolved.data.internalId }),
  );
  return ok({
    data: dependents.map((dependency) => ({
      ...dependency,
      dependent: { ...dependency.dependent, ref: { type: "spaces.item" as const, id: dependency.dependent.id } },
    })),
    refs: [itemRef(resolved.data.item, "task")],
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
    if (isEvent(resolved.data.item) || isEvent(blocker.data.item))
      return capabilityFail(context, err.badInput("Task dependencies can only connect tasks"), "taskDependenciesOnly");
    const result = await spacesService.item.dependencies.add({
      itemId: resolved.data.internalId,
      blockerItemId: blocker.data.internalId,
      spaceId: resolved.data.internalSpaceId,
    });
    if (!result.ok) return mutationError(result, context);
    const [data] = await spacesPublicResources.projectTaskDependencies([result.data]);
    if (!data) return capabilityFail(context, err.internal("Failed to project task dependency"), "operationFailed");
    return ok({
      data,
      summary: boundedCapabilitySummary(
        spacesMessages(context.locale).taskWaitsFor({ task: resolved.data.item.title, blocker: blocker.data.item.title }),
      ),
      refs: [itemRef(resolved.data.item, "task"), itemRef(blocker.data.item, "task")],
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
    if (!result.ok) return mutationError(result, context);
    return ok({
      data: { itemId: input.itemId, blockerItemId: input.blockerItemId, removed: true as const },
      summary: boundedCapabilitySummary(
        spacesMessages(context.locale).taskNoLongerWaitsFor({ task: resolved.data.item.title, blocker: blocker.data.item.title }),
      ),
      refs: [itemRef(resolved.data.item, "task"), itemRef(blocker.data.item, "task")],
      links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
    });
  });

const commentMutationResult = async (
  result: MutationResult<SpaceComment>,
  item: SpaceItem,
  summary: string,
  context: CapabilityExecutionContext,
) => {
  if (!result.ok) return mutationError(result, context);
  const [comment] = await spacesPublicResources.projectComments([result.data]);
  if (!comment) return capabilityFail(context, err.internal("Failed to project Space comment"), "operationFailed");
  return ok({
    data: mapComment(comment),
    summary: boundedCapabilitySummary(summary),
    refs: [commentRef(comment, item, context), itemRef(item, isEvent(item) ? "event" : "task")],
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
    if (!columnId || !tagIds) return capabilityFail(context, err.badInput("Unknown Space column or tag"), "unknownSpaceColumnOrTag");
    return itemMutationResult(
      await spacesService.item.create({
        spaceId: access.data.internalId,
        data: { ...data, columnId, tagIds },
        createdBy: context.user?.id ?? null,
        actor: spaceActivityActor(context),
      }),
      (item) => spacesMessages(context.locale).createdInSpace({ title: item.title, space: access.data.space.name }),
      context,
    );
  });

const runTaskUpdate = async (input: z.infer<typeof TaskUpdateInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "task.update", "space_item", input.itemId), async () => {
    const resolved = await requireItem(input.itemId, context, "write");
    if (!resolved.ok) return resolved;
    if (isEvent(resolved.data.item)) return capabilityFail(context, err.badInput("Item is not a task"), "itemNotTask");
    const { itemId, ...data } = input;
    const tagIds = await spacesPublicResources.resolveSpacePublicIds("tags", resolved.data.internalSpaceId, data.tagIds ?? []);
    if (!tagIds) return capabilityFail(context, err.badInput("Unknown Space tag"), "unknownSpaceTag");
    return itemMutationResult(
      await spacesService.item.update({
        id: resolved.data.internalId,
        data: { ...data, ...(data.tagIds ? { tagIds } : {}) },
        actor: spaceActivityActor(context),
      }),
      (item) => itemUpdateSummary(resolved.data.item, item, input, context),
      context,
    );
  });

const runTaskSetCompleted = async (input: z.infer<typeof TaskSetCompletedInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "task.set-completed", "space_item", input.itemId), async () => {
    const resolved = await requireItem(input.itemId, context, "write");
    if (!resolved.ok) return resolved;
    if (isEvent(resolved.data.item)) return capabilityFail(context, err.badInput("Item is not a task"), "itemNotTask");
    return itemMutationResult(
      await spacesService.item.setCompleted({
        id: resolved.data.internalId,
        expectedSpaceId: resolved.data.internalSpaceId,
        completed: input.completed,
        result: input.result,
        commit: input.commit,
        claimId: input.claimId,
        actor: spaceActivityActor(context),
      }),
      (item) =>
        input.completed
          ? spacesMessages(context.locale).completedTask({ title: item.title })
          : spacesMessages(context.locale).reopenedTask({ title: item.title }),
      context,
    );
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
    if (!columnId || !tagIds) return capabilityFail(context, err.badInput("Unknown Space column or tag"), "unknownSpaceColumnOrTag");
    return itemMutationResult(
      await spacesService.item.create({
        spaceId: access.data.internalId,
        data: { ...data, columnId, tagIds },
        createdBy: context.user?.id ?? null,
        actor: spaceActivityActor(context),
      }),
      (item) => spacesMessages(context.locale).createdInSpace({ title: item.title, space: access.data.space.name }),
      context,
    );
  });

const runEventCreateOnce = async (input: z.infer<typeof EventCreateInputSchema>, context: CapabilityExecutionContext) => {
  let replayed = false;
  return audited(
    actionAudit(context, "event.create-once", "space", input.spaceId),
    async () => {
      if (!context.idempotencyKey) return capabilityFail(context, err.badInput("Idempotency-Key is required"), "idempotencyKeyRequired");
      const access = await requireSpace(input.spaceId, context, "write");
      if (!access.ok) return access;
      const { spaceId, ...data } = input;
      const [columnIds, tagIds] = await Promise.all([
        spacesPublicResources.resolveSpacePublicIds("columns", access.data.internalId, [data.columnId]),
        spacesPublicResources.resolveSpacePublicIds("tags", access.data.internalId, data.tagIds ?? []),
      ]);
      const columnId = columnIds?.[0];
      if (!columnId || !tagIds) return capabilityFail(context, err.badInput("Unknown Space column or tag"), "unknownSpaceColumnOrTag");
      return itemMutationResult(
        await spacesService.item.create({
          spaceId: access.data.internalId,
          data: { ...data, columnId, tagIds },
          createdBy: context.user?.id ?? null,
          actor: spaceActivityActor(context),
          idempotency: {
            actorKey: capabilityActorKey(context),
            actionId: EVENT_CREATE_ONCE_ACTION_ID,
            idempotencyKeyHash: sha256(context.idempotencyKey),
            requestHash: sha256(JSON.stringify(input)),
            onReplay: () => {
              replayed = true;
            },
          },
        }),
        (item) => spacesMessages(context.locale).createdInSpace({ title: item.title, space: access.data.space.name }),
        context,
      );
    },
    () => replayed,
  );
};

const runEventUpdate = async (input: z.infer<typeof EventUpdateInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "event.update", "space_item", input.itemId), async () => {
    const resolved = await requireItem(input.itemId, context, "write");
    if (!resolved.ok) return resolved;
    if (!isEvent(resolved.data.item)) return capabilityFail(context, err.badInput("Item is not an event"), "itemNotEvent");
    const { itemId, ...data } = input;
    const tagIds = await spacesPublicResources.resolveSpacePublicIds("tags", resolved.data.internalSpaceId, data.tagIds ?? []);
    if (!tagIds) return capabilityFail(context, err.badInput("Unknown Space tag"), "unknownSpaceTag");
    return itemMutationResult(
      await spacesService.item.update({
        id: resolved.data.internalId,
        data: { ...data, ...(data.tagIds ? { tagIds } : {}) },
        actor: spaceActivityActor(context),
      }),
      (item) => itemUpdateSummary(resolved.data.item, item, input, context),
      context,
    );
  });

const runItemDelete = async (input: z.infer<typeof ItemDeleteInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "item.delete", "space_item", input.itemId), async () => {
    const resolved = await requireItem(input.itemId, context, "write");
    if (!resolved.ok) return resolved;
    const result = await spacesService.item.remove({ id: resolved.data.internalId, actor: spaceActivityActor(context) });
    return result.ok
      ? ok({
          data: { itemId: input.itemId, deleted: true as const },
          summary: boundedCapabilitySummary(
            spacesMessages(context.locale).deletedItem({
              kind: isEvent(resolved.data.item) ? spacesMessages(context.locale).event : spacesMessages(context.locale).task,
              title: resolved.data.item.title,
            }),
          ),
        })
      : mutationError(result, context);
  });

const runCommentCreate = async (input: z.infer<typeof CommentCreateInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "comment.create", "space_item", input.itemId), async () => {
    if (!context.user) return capabilityFail(context, err.forbidden("Comments require a user-backed actor"), "commentsNeedUser");
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
      spacesMessages(context.locale).addedComment({ title: resolved.data.item.title }),
      context,
    );
  });

const runCommentUpdate = async (input: z.infer<typeof CommentUpdateInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "comment.update", "space_comment", input.commentId), async () => {
    if (!context.user) return capabilityFail(context, err.forbidden("Comments require a user-backed actor"), "commentsNeedUser");
    const resolved = await resolveComment(input.commentId, context, "write");
    if (!resolved.ok) return resolved;
    return commentMutationResult(
      await spacesService.comment.update({ id: resolved.data.internalId, content: input.content, userId: context.user.id }),
      resolved.data.item,
      spacesMessages(context.locale).updatedComment({ title: resolved.data.item.title }),
      context,
    );
  });

const runCommentDelete = async (input: z.infer<typeof CommentDeleteInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "comment.delete", "space_comment", input.commentId), async () => {
    if (!context.user) return capabilityFail(context, err.forbidden("Comments require a user-backed actor"), "commentsNeedUser");
    const resolved = await resolveComment(input.commentId, context, "write");
    if (!resolved.ok) return resolved;
    const result = await spacesService.comment.remove({ id: resolved.data.internalId, userId: context.user.id });
    return result.ok
      ? ok({
          data: { commentId: input.commentId, deleted: true as const },
          summary: boundedCapabilitySummary(spacesMessages(context.locale).deletedComment({ title: resolved.data.item.title })),
        })
      : mutationError(result, context);
  });

const runCalendarInvitationPreview = async (
  input: z.infer<typeof CalendarInvitationPreviewCapabilityInputSchema>,
  context: CapabilityExecutionContext,
) => {
  const result = await spacesService.calendarInvitations.previewCalendarInvitation(input);
  if (!result.ok || !result.data.existing) {
    return result.ok
      ? ok({
          data: result.data,
          summary: boundedCapabilitySummary(spacesMessages(context.locale).previewedInvitation({ title: result.data.invitation.title })),
        })
      : fail(localizeSpacesError(result.error, context.locale));
  }
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
        summary: boundedCapabilitySummary(
          spacesMessages(context.locale).previewedLinkedInvitation({
            invitation: result.data.invitation.title,
            event: item.data.item.title,
          }),
        ),
        links: [{ rel: "open" as const, href: buildSpaceItemHref(access.data.space.id, item.data.item.id) }],
      })
    : ok({
        data: { ...result.data, existing: null, response: null },
        summary: boundedCapabilitySummary(spacesMessages(context.locale).previewedInvitation({ title: result.data.invitation.title })),
      });
};

const runCalendarInvitationResponsePrepare = async (
  input: z.infer<typeof CalendarInvitationResponsePrepareInputSchema>,
  context: CapabilityExecutionContext,
) => {
  const result = await spacesService.calendarInvitations.prepareCalendarResponse({ input, subject: context.accessSubject });
  return result.ok
    ? ok({
        data: result.data,
        summary: boundedCapabilitySummary(
          spacesMessages(context.locale).preparedCalendarResponse({
            subject: result.data.subject,
            status: participationStatusLabel(spacesMessages(context.locale), input.participationStatus),
          }),
        ),
      })
    : fail(localizeSpacesError(result.error, context.locale));
};

const calendarDestinationContext = async (
  input: z.infer<typeof CalendarDestinationListInputSchema>,
  context: CapabilityExecutionContext,
) => {
  const cursor = decodeSpacesCapabilityCursor(input.cursor, context.locale);
  if (!cursor.ok) return cursor;
  const scope = scopedSpaceId(context, "write");
  if (!scope.ok) return scope;
  const page = await spacesService.space.list({
    subject: context.accessSubject,
    boundSpaceId: scope.data,
    requiredLevel: "write",
    pagination: { page: cursor.data, perPage: input.limit },
  });
  const spaces = await spacesPublicResources.projectSpaces(page.items);
  return ok({
    data: spaces.map((space) => ({
      id: space.id,
      ref: { type: "spaces.space" as const, id: space.id },
      name: space.name,
      color: space.color,
      links: [{ rel: "open" as const, href: `/app/spaces/${space.id}` }],
    })),
    refs: spaces.map(spaceRef),
    page: capabilityPage(page.hasNext ? encodeCursor(page.page + 1) : undefined),
  });
};

const runCalendarInvitationImport = async (
  input: z.infer<typeof CalendarInvitationImportCapabilityInputSchema>,
  context: CapabilityExecutionContext,
) =>
  audited(actionAudit(context, "calendar-invitation.import", "space", input.spaceId), async () => {
    if (!context.user)
      return capabilityFail(context, err.forbidden("Importing an invitation requires a user-backed actor"), "invitationImportNeedsUser");
    const access = await requireSpace(input.spaceId, context, "write");
    if (!access.ok) return access;
    const result = await spacesService.calendarInvitations.importCalendarInvitation({
      input: { ...input, spaceId: access.data.internalId },
      user: context.user,
      subject: context.accessSubject,
    });
    if (!result.ok) return fail(localizeSpacesError(result.error, context.locale));
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
      summary: boundedCapabilitySummary(
        result.data.outcome === "created"
          ? spacesMessages(context.locale).importedInvitationCreated({ title: item.data.item.title, space: access.data.space.name })
          : result.data.outcome === "updated"
            ? spacesMessages(context.locale).importedInvitationUpdated({ title: item.data.item.title })
            : result.data.outcome === "cancelled"
              ? spacesMessages(context.locale).importedInvitationCancelled({ title: item.data.item.title })
              : spacesMessages(context.locale).importedInvitationUnchanged({ title: item.data.item.title }),
      ),
      refs: [itemRef(item.data.item, "event")],
      links: [{ rel: "open", href: data.href }],
    });
  });

const runCalendarInvitationResponseCommit = async (
  input: z.infer<typeof CalendarInvitationResponseCommitCapabilityInputSchema>,
  context: CapabilityExecutionContext,
) =>
  audited(actionAudit(context, "calendar-invitation.response.commit", "mail_draft", input.draftId), async () => {
    const source = await spacesService.calendarInvitations.getCalendarResponseCommitContext({
      input,
      subject: context.accessSubject,
    });
    if (!source.ok) return source;
    const result = await spacesService.calendarInvitations.commitCalendarResponse({ input, subject: context.accessSubject });
    return result.ok
      ? ok({
          data: result.data,
          summary: boundedCapabilitySummary(
            spacesMessages(context.locale).attachedCalendarResponse({
              status: participationResponseLabel(spacesMessages(context.locale), input.participationStatus),
              title: source.data.title,
            }),
          ),
          refs: [{ type: "mail.draft", id: input.draftId }],
        })
      : fail(localizeSpacesError(result.error, context.locale));
  });

const runEventInvitationPrepare = async (input: z.infer<typeof EventInvitationPrepareInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "event.invitation.prepare", "space_item", input.itemId), async () => {
    if (!context.idempotencyKey)
      return capabilityFail(context, err.badInput("An idempotency key is required"), "genericIdempotencyKeyRequired");
    const resolved = await requireItem(input.itemId, context, "write");
    if (!resolved.ok) return resolved;
    if (!isEvent(resolved.data.item)) return capabilityFail(context, err.badInput("Item is not an event"), "itemNotEvent");
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
          summary: boundedCapabilitySummary(spacesMessages(context.locale).preparedInvitation({ title: resolved.data.item.title })),
          refs: [itemRef(resolved.data.item, "event"), { type: "mail.draft", id: result.data.draftId }],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, resolved.data.item.id) }],
        })
      : fail(localizeSpacesError(result.error, context.locale));
  });

const runEventInvitationCommit = async (input: z.infer<typeof EventInvitationCommitInputSchema>, context: CapabilityExecutionContext) =>
  audited(actionAudit(context, "event.invitation.commit", "calendar_invitation_delivery", input.deliveryId), async () => {
    const result = await spacesService.calendarInvitations.commitEventInvitationAttachment({
      deliveryId: input.deliveryId,
      subject: context.accessSubject,
    });
    if (!result.ok) return fail(localizeSpacesError(result.error, context.locale));
    const resolved = await requireItemUuid(result.data.itemId, context);
    if (!resolved.ok) return resolved;
    return ok({
      data: { ...result.data, itemId: resolved.data.item.id },
      summary: boundedCapabilitySummary(spacesMessages(context.locale).attachedInvitation({ title: resolved.data.item.title })),
      refs: [itemRef(resolved.data.item, "event"), { type: "mail.draft", id: result.data.draftId }],
      links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, resolved.data.item.id) }],
    });
  });

export const spacesCapabilities = defineCapabilities({
  protocolVersion: 1,
  presentation: spacesCapabilityPresentation,
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
    "task.work.read": {
      title: "Read task work state",
      description:
        "Read the current claim, full progress note and last completion result, including verification and commit. Reopening preserves the result. Use item.read and the existing checklist, comment and dependency queries for other context.",
      input: ItemReadInputSchema,
      data: TaskWorkSchema,
      openWorld: false,
      run: async (input, context) => {
        const resolved = await requireItem(input.id, context);
        if (!resolved.ok) return resolved;
        return ok({ data: await taskWork.read(resolved.data.internalId) });
      },
    },
    "space.search": {
      title: "Search spaces",
      description:
        "Find an accessible Space by name or description when its ID is unknown. Use returned spaces.space refs with space.read or their IDs with task.list, event.list, and item Actions.",
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
      description:
        "Direct cross-Space entry for finding readable tasks and events by text or workflow facets. Use returned spaces.item refs with item.read; use task.list or event.list to browse one known Space.",
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
      description:
        "Specialized cross-Space search for writable tasks or events before item.reference.add. Use item.search for normal reading; pass a returned spaces.item ref as the Action target.",
      input: ItemLinkCandidateSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      run: (input, context) => runItemSearch({ ...input, tags: [] }, context, "write"),
    },
    "task.focus": {
      title: "Find actionable tasks",
      description:
        "Compact paginated open-task work queue across readable Spaces. Filter assignment, deadline, priority, blockers or 30-day inactivity. Use item.read only for full content and task.checklist.list for checklist entries.",
      input: TaskFocusInputSchema,
      data: TaskFocusDataSchema,
      openWorld: false,
      run: async (input, context) => {
        const access = await workQueryContext(input, context);
        return access.ok ? ok(await runTaskFocus(input, access.data)) : access;
      },
    },
    "event.agenda": {
      title: "Read calendar occurrences",
      description:
        "Read open event occurrences in an inclusive-from, exclusive-to interval of at most 31 days, expanded server-side in the application timezone. Follow page.nextCursor even on empty pages. Each page is chronological; collect all pages and sort startsAt for a complete agenda. Cursors require unchanged interval, Space and assignment filters. Task deadlines are not included.",
      input: EventAgendaInputSchema,
      data: EventAgendaDataSchema,
      openWorld: false,
      run: async (input, context) => {
        const access = await workQueryContext(input, context, true);
        if (!access.ok) return access;
        try {
          return ok(await runEventAgenda(input, access.data));
        } catch (error) {
          if (error instanceof AgendaCursorError) return fail(err.badInput(spacesMessages(context.locale).invalidCursor));
          if (error instanceof CalendarReadLimitError) return fail(err.badInput(spacesMessages(context.locale).calendarReadLimit));
          throw error;
        }
      },
    },
    "space.browse": {
      title: "Browse Spaces",
      description:
        "Compact paginated Space selection with effective permissions. Use minimumPermission write before creating items; read a Space only when column or tag IDs are needed.",
      input: SpaceListInputSchema,
      data: SpaceBrowseDataSchema,
      openWorld: false,
      run: runSpaceBrowse,
    },
    "task.checklist.list": {
      title: "List task checklist",
      description:
        "Read paginated checklist entries of one task: entry ID, label, and completed state. Follow page.nextCursor until complete. Entries are simple checkmarks, not independent tasks.",
      input: TaskChecklistListInputSchema,
      data: TaskChecklistListDataSchema,
      openWorld: false,
      run: runChecklistList,
    },
    "space.list": {
      title: "List spaces",
      description:
        "Normal entry for Space-scoped work. List accessible Spaces with effective permission; use returned spaces.space refs or IDs with space.read, task.list, event.list, and item creation Actions.",
      input: SpaceListInputSchema,
      data: SpaceListDataSchema,
      openWorld: false,
      run: runSpaceList,
    },
    "space.read": {
      title: "Read space",
      description:
        "Read one spaces.space ref returned by space.list or space.search, including column and tag IDs required by filtered lists and item Actions.",
      input: SpaceReadInputSchema,
      data: SpaceDetailDataSchema,
      openWorld: false,
      run: runSpaceRead,
    },
    "space.assignee.list": {
      title: "List assignable Space members",
      description:
        "List people eligible for task or event assignment in one writable Space. Get spaceId from space.list or space.search and pass a returned user ID to an item Action.",
      input: SpaceAssigneeListInputSchema,
      data: SpaceAssigneeListDataSchema,
      openWorld: false,
      run: runSpaceAssigneeList,
    },
    "task.list": {
      title: "List tasks",
      description:
        "Browse tasks in one known Space. Get spaceId, columnIds, and tagIds from space.read; use returned spaces.item refs with item.read, dependency queries, comments, or task Actions.",
      input: TaskListInputSchema,
      data: TaskListDataSchema,
      openWorld: false,
      run: (input, context) => runItemList(input, context, "task"),
    },
    "event.list": {
      title: "List events",
      description:
        "Browse calendar events in one known Space. Get spaceId, columnIds, and tagIds from space.read; use returned spaces.item refs with item.read, comments, or event Actions.",
      input: EventListInputSchema,
      data: EventListDataSchema,
      openWorld: false,
      run: (input, context) => runItemList(input, context, "event"),
    },
    "item.read": {
      title: "Read Space item",
      description:
        "Read one spaces.item ref returned by item.search, task.list, event.list, or a reference query. The kind field distinguishes tasks from events for subsequent Actions.",
      input: ItemReadInputSchema,
      data: ItemDataSchema,
      openWorld: false,
      run: runItemRead,
    },
    "item.reference.find": {
      title: "Find items linked to a resource",
      description:
        "Find readable Space items linked to one known Cloud resource ref. Use returned spaces.item refs with item.read; use item.search for title or workflow discovery instead.",
      input: ItemResourceReferenceFindInputSchema,
      data: ItemResourceReferenceFindDataSchema,
      openWorld: false,
      run: runItemReferenceFind,
    },
    "item.reference.list": {
      title: "List item resource links",
      description:
        "List Cloud resource refs attached to one known spaces.item ref. Returned refs can be passed directly to their owning app readers; use item.reference.find for the reverse lookup.",
      input: ItemResourceReferenceListInputSchema,
      data: ItemResourceReferenceListDataSchema,
      openWorld: false,
      run: runItemReferenceList,
    },
    "task.blocker.list": {
      title: "List task blockers",
      description:
        "List tasks that block one known task. Get itemId from task.list, item.search, or item.read; returned spaces.item refs can be opened with item.read.",
      input: TaskDependencyListInputSchema,
      data: TaskDependencyListDataSchema,
      openWorld: false,
      run: runTaskDependencyList,
    },
    "task.blocks.list": {
      title: "List tasks blocked by a task",
      description:
        "List tasks currently blocked by one known task. Get itemId from task.list, item.search, or item.read; use task.blocker.list for the opposite direction.",
      input: TaskDependencyListInputSchema,
      data: TaskDependentListDataSchema,
      openWorld: false,
      run: runTaskDependentList,
    },
    "comment.list": {
      title: "List comments",
      description:
        "List comments on one known item or recurring occurrence after checking Space access. Get itemId from a spaces.item ref; use returned spaces.comment refs with comment.read.",
      input: CommentListInputSchema,
      data: CommentListDataSchema,
      openWorld: false,
      run: runCommentList,
    },
    "comment.read": {
      title: "Read comment",
      description: "Read one spaces.comment ref returned by comment.list after checking its parent item and Space.",
      input: CommentReadInputSchema,
      data: CommentDataSchema,
      openWorld: false,
      run: runCommentRead,
    },
    "calendar-invitation.preview": {
      title: "Preview calendar invitation",
      description:
        "Start a Mail-to-Spaces invitation flow by parsing bounded iCalendar content with its Mail mailboxId and messageId. Shows a visible linked event; otherwise use calendar-destination.list before calendar-invitation.import.",
      input: CalendarInvitationPreviewCapabilityInputSchema,
      data: CalendarInvitationPreviewCapabilityDataSchema,
      openWorld: false,
      run: runCalendarInvitationPreview,
    },
    "calendar-destination.list": {
      title: "List calendar destinations",
      description:
        "List writable destination Spaces after calendar-invitation.preview finds no linked event. Pass a returned spaceId to calendar-invitation.import.",
      input: CalendarDestinationListInputSchema,
      data: CalendarDestinationListDataSchema,
      openWorld: false,
      run: calendarDestinationContext,
    },
    "calendar-invitation.response.prepare": {
      title: "Prepare calendar response",
      description:
        "Prepare a standards-based response after calendar-invitation.preview finds an imported writable Space event. Create the returned payload with mail.draft.create, then call calendar-invitation.response.commit; Mail IDs are correlation values, not Space authorization.",
      input: CalendarInvitationResponsePrepareInputSchema,
      data: CalendarInvitationResponsePrepareDataSchema,
      openWorld: false,
      run: runCalendarInvitationResponsePrepare,
    },
  },
  actions: {
    "task.claim": {
      title: "Claim task work",
      description:
        "Claim an open unblocked task for one worker. Generate a UUID claimId and reuse it only for retries; competing claims return a conflict.",
      input: ClaimTaskSchema.extend({ itemId: ItemReadInputSchema.shape.id }),
      data: TaskWorkSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      run: async (input, context) =>
        audited(actionAudit(context, "task.claim", "space_item", input.itemId), async () => {
          const resolved = await requireItem(input.itemId, context, "write");
          if (!resolved.ok) return resolved;
          const result = await taskWork.change({
            itemId: resolved.data.internalId,
            spaceId: resolved.data.internalSpaceId,
            actor: spaceActivityActor(context),
            subject: context.accessSubject,
            operation: "claim",
            ...{ claimId: input.claimId },
          });
          return result.ok ? ok({ data: result.data }) : mutationError(result, context);
        }),
    },
    "task.release": {
      title: "Release task work",
      description: "Release your current claim using its exact claimId. Progress and completion results remain available.",
      input: ReleaseTaskSchema.extend({ itemId: ItemReadInputSchema.shape.id }),
      data: TaskWorkSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      run: async (input, context) =>
        audited(actionAudit(context, "task.release", "space_item", input.itemId), async () => {
          const resolved = await requireItem(input.itemId, context, input.force ? "admin" : "write");
          if (!resolved.ok) return resolved;
          const result = await taskWork.change({
            itemId: resolved.data.internalId,
            spaceId: resolved.data.internalSpaceId,
            actor: spaceActivityActor(context),
            subject: context.accessSubject,
            operation: "release",
            ...{ claimId: input.claimId, force: input.force },
          });
          return result.ok ? ok({ data: result.data }) : mutationError(result, context);
        }),
    },
    "task.progress": {
      title: "Progress task work",
      description:
        "Save a full progress and handoff note under the actual user or service account identity. Supply the current claimId when claimed; the previous note remains in task activity.",
      input: ProgressTaskSchema.extend({ itemId: ItemReadInputSchema.shape.id }),
      data: TaskWorkSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      run: async (input, context) =>
        audited(actionAudit(context, "task.progress", "space_item", input.itemId), async () => {
          const resolved = await requireItem(input.itemId, context, "write");
          if (!resolved.ok) return resolved;
          const result = await taskWork.change({
            itemId: resolved.data.internalId,
            spaceId: resolved.data.internalSpaceId,
            actor: spaceActivityActor(context),
            subject: context.accessSubject,
            operation: "progress",
            ...{ claimId: input.claimId, content: input.content },
          });
          return result.ok ? ok({ data: result.data }) : mutationError(result, context);
        }),
    },
    "task.checklist.create": {
      title: "Add task checklist entry",
      description: "Append one simple checklist label to a writable task.",
      input: TaskChecklistCreateInputSchema,
      data: TaskChecklistDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: reviewChecklist,
      run: runChecklistCreate,
    },
    "task.checklist.update": {
      title: "Update task checklist entry",
      description: "Change only the supplied label or completed state of an entry returned by task.checklist.list.",
      input: TaskChecklistUpdateInputSchema,
      data: TaskChecklistDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: reviewChecklist,
      run: runChecklistUpdate,
    },
    "task.checklist.delete": {
      title: "Delete task checklist entry",
      description: "Remove one checklist entry from a writable task; the task itself is preserved.",
      input: TaskChecklistDeleteInputSchema,
      data: TaskChecklistDeleteDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: reviewChecklist,
      run: runChecklistDelete,
    },
    "item.reference.add": {
      title: "Link a Cloud resource",
      description: "Link one stable Cloud resource reference to a writable Space item.",
      input: ItemResourceReferenceAddInputSchema,
      data: ItemResourceReferenceDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: async (input, context) => {
        const t = spacesMessages(context.locale);
        const resolved = await requireItem(input.itemId, context, "write");
        if (!resolved.ok) return resolved;
        return ok({
          message: t.reviewLinkResource({ resource: input.reference.label, item: resolved.data.item.title }),
          details: [
            { label: t.item, value: resolved.data.item.title },
            { label: t.resource, value: input.reference.label },
            { label: t.reference, value: `${input.reference.ref.type}:${input.reference.ref.id}` },
          ],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
          approvalScope: spaceApprovalScope(resolved.data.item.spaceId),
        });
      },
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
      approval: "rememberable",
      review: async (input, context) => {
        const t = spacesMessages(context.locale);
        const resolved = await requireItem(input.itemId, context, "write");
        if (!resolved.ok) return resolved;
        return ok({
          message: t.reviewUnlinkResource({ item: resolved.data.item.title }),
          details: [
            { label: t.item, value: resolved.data.item.title },
            { label: t.reference, value: `${input.ref.type}:${input.ref.id}` },
          ],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
          approvalScope: spaceApprovalScope(resolved.data.item.spaceId),
        });
      },
      run: runItemReferenceRemove,
    },
    "item.tags.set": {
      title: "Set item tags",
      description: "Replace the tags on one writable task or event without changing its other fields.",
      input: ItemTagsSetInputSchema,
      data: ItemDataSchema,
      destructive: true,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: async (input, context) => {
        const t = spacesMessages(context.locale);
        const resolved = await requireItem(input.itemId, context, "write");
        if (!resolved.ok) return resolved;
        const details = await relationReviewDetails({ tagIds: input.tagIds }, resolved.data.internalSpaceId, context);
        return ok({
          message: t.reviewReplaceTags({ item: resolved.data.item.title }),
          details: [{ label: t.item, value: resolved.data.item.title }, ...details],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
          approvalScope: spaceApprovalScope(resolved.data.item.spaceId),
        });
      },
      run: runItemTagsSet,
    },
    "task.blocker.add": {
      title: "Add task blocker",
      description: "Mark one task in the same Space as a blocker of another task.",
      input: TaskDependencyInputSchema,
      data: TaskDependencyDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      review: async (input, context) => {
        const t = spacesMessages(context.locale);
        const [resolved, blocker] = await Promise.all([
          requireItem(input.itemId, context, "write"),
          requireItem(input.blockerItemId, context, "read"),
        ]);
        if (!resolved.ok) return resolved;
        if (!blocker.ok) return blocker;
        if (isEvent(resolved.data.item) || isEvent(blocker.data.item))
          return capabilityFail(context, err.badInput("Task dependencies can only connect tasks"), "taskDependenciesOnly");
        if (resolved.data.item.spaceId !== blocker.data.item.spaceId)
          return capabilityFail(context, err.badInput("Task dependencies must stay in one Space"), "taskDependenciesSameSpace");
        return ok({
          message: t.reviewAddBlocker({ task: resolved.data.item.title, blocker: blocker.data.item.title }),
          details: [
            { label: t.task, value: resolved.data.item.title },
            { label: t.blockedBy, value: blocker.data.item.title },
          ],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
          approvalScope: spaceApprovalScope(resolved.data.item.spaceId),
        });
      },
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
      approval: "rememberable",
      review: async (input, context) => {
        const t = spacesMessages(context.locale);
        const [resolved, blocker] = await Promise.all([
          requireItem(input.itemId, context, "write"),
          requireItem(input.blockerItemId, context, "read"),
        ]);
        if (!resolved.ok) return resolved;
        if (!blocker.ok) return blocker;
        if (isEvent(resolved.data.item) || isEvent(blocker.data.item))
          return capabilityFail(context, err.badInput("Task dependencies can only connect tasks"), "taskDependenciesOnly");
        if (resolved.data.item.spaceId !== blocker.data.item.spaceId)
          return capabilityFail(context, err.badInput("Task dependencies must stay in one Space"), "taskDependenciesSameSpace");
        return ok({
          message: t.reviewRemoveBlocker({ task: resolved.data.item.title, blocker: blocker.data.item.title }),
          details: [
            { label: t.task, value: resolved.data.item.title },
            { label: t.blockedBy, value: blocker.data.item.title },
          ],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
          approvalScope: spaceApprovalScope(resolved.data.item.spaceId),
        });
      },
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
        const t = spacesMessages(context.locale);
        const resolved = await requireItem(input.itemId, context, "write");
        if (!resolved.ok) return resolved;
        if (isEvent(resolved.data.item)) return capabilityFail(context, err.badInput("Item is not a task"), "itemNotTask");
        const relations = await relationReviewDetails(input, resolved.data.internalSpaceId, context);
        return ok({
          message: t.reviewUpdateTask({ title: resolved.data.item.title }),
          details: [
            { label: t.task, value: resolved.data.item.title },
            ...(input.title !== undefined ? [{ label: t.title, value: input.title }] : []),
            ...(input.description !== undefined
              ? [
                  input.description === null
                    ? { label: t.description, value: t.clearDescription }
                    : { label: t.description, value: input.description, display: "block" as const },
                ]
              : []),
            ...(input.deadline !== undefined
              ? [
                  input.deadline === null
                    ? { label: t.deadline, value: t.clearDeadline }
                    : { label: t.deadline, value: input.deadline, format: "date-time" as const },
                ]
              : []),
            ...(input.estimatedDurationMinutes !== undefined
              ? [
                  {
                    label: t.estimatedDuration,
                    value: input.estimatedDurationMinutes === null ? t.clearEstimate : t.minutes({ count: input.estimatedDurationMinutes }),
                  },
                ]
              : []),
            ...(input.priority !== undefined ? [{ label: t.priority, value: input.priority ?? t.noPriority }] : []),
            ...relations,
          ],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
          approvalScope: spaceApprovalScope(resolved.data.item.spaceId),
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
        const t = spacesMessages(context.locale);
        const resolved = await requireItem(input.itemId, context, "write");
        if (!resolved.ok) return resolved;
        if (isEvent(resolved.data.item)) return capabilityFail(context, err.badInput("Item is not a task"), "itemNotTask");
        if (input.completed && resolved.data.item.activeBlockerCount > 0) {
          return capabilityFail(context, err.conflict("Complete all blocking tasks first"), "completeBlockersFirst");
        }
        return ok({
          message: input.completed
            ? t.reviewCompleteTask({ title: resolved.data.item.title })
            : t.reviewReopenTask({ title: resolved.data.item.title }),
          details: [
            { label: t.task, value: resolved.data.item.title },
            ...(input.result !== undefined ? [{ label: t.workResult, value: input.result, display: "block" as const }] : []),
            ...(input.commit ? [{ label: "Commit", value: input.commit }] : []),
          ],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
          approvalScope: spaceApprovalScope(resolved.data.item.spaceId),
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
    "event.create-once": {
      title: "Create calendar event once",
      description: "Create one calendar event with retry-safe idempotency for durable workflows.",
      input: EventCreateInputSchema,
      data: EventDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      run: runEventCreateOnce,
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
        const t = spacesMessages(context.locale);
        const resolved = await requireItem(input.itemId, context, "write");
        if (!resolved.ok) return resolved;
        if (!isEvent(resolved.data.item)) return capabilityFail(context, err.badInput("Item is not an event"), "itemNotEvent");
        const [relations, dateConfig] = await Promise.all([
          relationReviewDetails(input, resolved.data.internalSpaceId, context),
          input.recurrence !== undefined ? capabilityDateConfig(context) : Promise.resolve(undefined),
        ]);
        const allDay = input.allDay ?? resolved.data.item.allDay;
        const recurrence =
          input.recurrence === undefined
            ? undefined
            : input.recurrence === null
              ? t.doesNotRepeat
              : `${
                  summarizeRecurrence(input.recurrence, {
                    startsAt: input.startsAt ?? resolved.data.item.startsAt,
                    allDay,
                    dateConfig,
                  }) ?? t.customRecurrence
                }${input.recurrence.exdate.length > 0 ? ` · ${t.excludedDates({ count: input.recurrence.exdate.length })}` : ""}`;
        return ok({
          message: t.reviewUpdateEvent({ title: resolved.data.item.title }),
          details: [
            { label: t.event, value: resolved.data.item.title },
            ...(input.title !== undefined ? [{ label: t.title, value: input.title }] : []),
            ...(input.description !== undefined
              ? [
                  input.description === null
                    ? { label: t.description, value: t.clearDescription }
                    : { label: t.description, value: input.description, display: "block" as const },
                ]
              : []),
            ...(input.location !== undefined ? [{ label: t.location, value: input.location ?? t.clearLocation }] : []),
            ...(input.url !== undefined ? [{ label: t.link, value: input.url ?? t.clearLink }] : []),
            ...(input.startsAt !== undefined
              ? [
                  {
                    label: t.starts,
                    value: input.startsAt,
                    format: allDay ? ("date" as const) : ("date-time" as const),
                  },
                ]
              : []),
            ...(input.endsAt !== undefined
              ? [
                  {
                    label: t.ends,
                    value: input.endsAt,
                    format: allDay ? ("date" as const) : ("date-time" as const),
                  },
                ]
              : []),
            ...(input.allDay !== undefined ? [{ label: t.allDay, value: input.allDay ? t.yes : t.no }] : []),
            ...(recurrence !== undefined ? [{ label: t.recurrence, value: recurrence }] : []),
            ...relations,
          ],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
          approvalScope: spaceApprovalScope(resolved.data.item.spaceId),
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
        const t = spacesMessages(context.locale);
        const delivery = await spacesService.calendarInvitations.getEventInvitationCommitContext({
          deliveryId: input.deliveryId,
          subject: context.accessSubject,
        });
        if (!delivery.ok) return delivery;
        const item = await requireItemUuid(delivery.data.itemId, context, "write");
        if (!item.ok) return item;
        return ok({
          message: t.reviewAttachInvitation({ title: delivery.data.title }),
          details: [
            { label: t.event, value: delivery.data.title },
            { label: t.draft, value: delivery.data.draftId },
          ],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(item.data.item.spaceId, item.data.item.id) }],
          approvalScope: spaceApprovalScope(item.data.item.spaceId),
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
        const t = spacesMessages(context.locale);
        const resolved = await requireItem(input.itemId, context, "write");
        if (!resolved.ok) return resolved;
        return ok({
          message: t.reviewDeleteItem({
            kind: isEvent(resolved.data.item) ? t.event : t.task,
            title: resolved.data.item.title,
          }),
          details: [{ label: isEvent(resolved.data.item) ? t.event : t.task, value: resolved.data.item.title }],
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
      approval: "rememberable",
      review: async (input, context) => {
        const t = spacesMessages(context.locale);
        if (!context.user) return capabilityFail(context, err.forbidden("Comments require a user-backed actor"), "commentsNeedUser");
        const resolved = await requireItem(input.itemId, context, "write");
        if (!resolved.ok) return resolved;
        return ok({
          message: t.reviewPostComment({ title: resolved.data.item.title }),
          details: [
            { label: t.item, value: resolved.data.item.title },
            { label: t.comment, value: input.content, display: "block" },
          ],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, input.itemId) }],
          approvalScope: itemApprovalScope(input.itemId),
        });
      },
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
        const t = spacesMessages(context.locale);
        if (!context.user) return capabilityFail(context, err.forbidden("Comments require a user-backed actor"), "commentsNeedUser");
        const resolved = await resolveComment(input.commentId, context, "write");
        if (!resolved.ok) return resolved;
        if (resolved.data.comment.userId !== context.user.id)
          return capabilityFail(context, err.forbidden("Only the comment author may edit it"), "commentAuthorEditOnly");
        return ok({
          message: t.reviewUpdateComment({ title: resolved.data.item.title }),
          details: [
            { label: t.item, value: resolved.data.item.title },
            { label: t.currentComment, value: resolved.data.comment.content, display: "block" },
            { label: t.replacementComment, value: input.content, display: "block" },
          ],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(resolved.data.item.spaceId, resolved.data.item.id) }],
          approvalScope: itemApprovalScope(resolved.data.item.id),
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
        const t = spacesMessages(context.locale);
        if (!context.user) return capabilityFail(context, err.forbidden("Comments require a user-backed actor"), "commentsNeedUser");
        const resolved = await resolveComment(input.commentId, context, "write");
        if (!resolved.ok) return resolved;
        if (resolved.data.comment.userId !== context.user.id)
          return capabilityFail(context, err.forbidden("Only the comment author may delete it"), "commentAuthorDeleteOnly");
        return ok({
          message: t.reviewDeleteComment({ title: resolved.data.item.title }),
          details: [
            { label: t.item, value: resolved.data.item.title },
            { label: t.comment, value: resolved.data.comment.content, display: "block" },
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
        const t = spacesMessages(context.locale);
        if (!context.user)
          return capabilityFail(
            context,
            err.forbidden("Importing an invitation requires a user-backed actor"),
            "invitationImportNeedsUser",
          );
        const access = await requireSpace(input.spaceId, context, "write");
        if (!access.ok) return access;
        const preview = await spacesService.calendarInvitations.previewCalendarInvitation(input);
        if (!preview.ok) return preview;
        if (preview.data.existing && preview.data.existing.spaceId !== access.data.internalId) {
          return capabilityFail(context, err.conflict("This calendar event is already linked to another Space"), "calendarAlreadyLinked");
        }
        const decision = spacesService.calendarInvitations.decideCalendarImport({
          existing: preview.data.existing,
          invitation: preview.data.invitation,
        });
        if (decision === "reject_cancellation")
          return capabilityFail(context, err.badInput("Cannot import a cancellation without an existing event"), "cancellationNeedsEvent");
        const consequence = decision === "create" ? t.importCreate : decision === "unchanged" ? t.importKeep : t.importUpdate;
        return ok({
          message: t.reviewImportInvitation({ action: consequence, title: preview.data.invitation.title, space: access.data.space.name }),
          details: [
            { label: t.space, value: access.data.space.name },
            { label: t.event, value: preview.data.invitation.title },
            { label: t.method, value: preview.data.invitation.method },
            { label: t.starts, value: preview.data.invitation.startsAt, format: "date-time" },
            { label: t.ends, value: preview.data.invitation.endsAt, format: "date-time" },
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
        const t = spacesMessages(context.locale);
        const source = await spacesService.calendarInvitations.getCalendarResponseCommitContext({
          input,
          subject: context.accessSubject,
        });
        if (!source.ok) return source;
        const item = await requireItemUuid(source.data.itemId, context, "write");
        if (!item.ok) return item;
        return ok({
          message: t.reviewRecordResponse({ status: participationStatusLabel(t, input.participationStatus), title: source.data.title }),
          details: [
            { label: t.event, value: source.data.title },
            { label: t.response, value: participationStatusLabel(t, input.participationStatus) },
            { label: t.draft, value: input.draftId },
          ],
          links: [{ rel: "open" as const, href: buildSpaceItemHref(item.data.item.spaceId, item.data.item.id) }],
          approvalScope: spaceApprovalScope(item.data.item.spaceId),
        });
      },
      run: runCalendarInvitationResponseCommit,
    },
  },
});
