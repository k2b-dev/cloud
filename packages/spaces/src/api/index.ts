import { err, fail, ok, type Result } from "@k2b/stdlib";
import {
  type AccessSubject,
  type AuthContext,
  auth,
  getDateConfig,
  hasPermission,
  jsonResponse,
  rateLimit,
  requiresAuth,
  respond,
  v,
} from "@valentinkolb/cloud/server";
import { coreSettings } from "@valentinkolb/cloud/services";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import type { MutationResult, PermissionLevel, User } from "@/contracts";
import {
  AccessEntrySchema,
  CalendarItemSchema,
  CalendarQuerySchema,
  CreateColumnSchema,
  CreateCommentSchema,
  CreateItemSchema,
  CreateSpaceSchema,
  CreateTagSchema,
  CreateWormholeSchema,
  ErrorResponseSchema,
  GrantAccessSchema,
  ItemFilterSchema,
  ItemListResultSchema,
  MAX_TASK_ATTACHMENT_SIZE_BYTES,
  MessageResponseSchema,
  MoveItemSchema,
  OverlapItemSchema,
  OverlapQuerySchema,
  ReorderColumnsSchema,
  ReorderWormholesSchema,
  SetCompletedSchema,
  SpaceAssignableUserSchema,
  SpaceColumnSchema,
  SpaceCommentSchema,
  SpaceDetailSchema,
  SpaceItemAttachmentSchema,
  SpaceItemResourceReferenceInputSchema,
  SpaceItemResourceReferenceSchema,
  SpaceItemSchema,
  SpaceSchema,
  SpaceTagSchema,
  SpaceTaskDependencyInputSchema,
  SpaceTaskDependencySchema,
  SpaceTaskDependentSchema,
  SpaceWormholeDestinationSchema,
  SpaceWormholeSchema,
  SplitRecurringItemSchema,
  UpdateAccessSchema,
  UpdateColumnSchema,
  UpdateCommentSchema,
  UpdateItemSchema,
  UpdateSpaceSchema,
  UpdateTagSchema,
  UpdateWormholeSchema,
  WormholeTransferResultSchema,
} from "@/contracts";
import { SpaceApiKeySchema, SpaceSettingsContextSchema } from "@/settings-context";
import { loadSpaceSettingsContext } from "../frontend/[id]/_components/edit/settings-state";
import { parseSpaceSettings } from "../frontend/[id]/_components/settings/SpaceSettingsStore";
import { loadSpaceItemDetail, loadSpacesViewSnapshot } from "../frontend/[id]/_components/workspace/workspace-state";
import {
  parseSpacesWorkspaceHref,
  SpaceCommentPageSchema,
  SpaceItemDetailSchema,
  SpacesViewSnapshotSchema,
} from "../frontend/[id]/_components/workspace/workspace-types";
import { CreateEventInvitationDraftInputSchema, EventInvitationContextSchema, EventInvitationDraftSchema } from "../integration";
import { spacesService } from "../service";
import { isSpaceResourceId, SPACE_RESOURCE_TYPE, SPACES_APP_ID } from "../service/access";
import {
  projectCalendarItems,
  projectColumns,
  projectComments,
  projectItems,
  projectOverlapItems,
  projectSpaces,
  projectTags,
  projectTaskDependencies,
  projectTaskDependents,
  projectWormholeDestinations,
  projectWormholes,
  projectWormholeTargets,
  resolvePublicId,
  resolvePublicIds,
  resolveSpacePublicIds,
} from "../service/public-resources";
import wsRoutes from "../ws";

// ==========================
// Spaces API
// ==========================

const SpaceListSchema = z.array(SpaceSchema);
const SpaceItemListSchema = z.array(SpaceItemSchema);
const SpaceCommentListSchema = z.array(SpaceCommentSchema);
const SpaceItemResourceReferenceListSchema = z.array(SpaceItemResourceReferenceSchema);
const SpaceItemAttachmentListSchema = z.array(SpaceItemAttachmentSchema);
const SpaceTaskDependencyListSchema = z.array(SpaceTaskDependencySchema);
const SpaceTaskDependentListSchema = z.array(SpaceTaskDependentSchema);
const ResourceReferenceDeleteSchema = z.object({ ref: SpaceItemResourceReferenceInputSchema.shape.ref }).strict();
const ResourceReferenceDeleteResultSchema = z.object({ deleted: z.boolean() }).strict();
const SpaceAssignableUserListSchema = z.array(SpaceAssignableUserSchema);
const SpaceWormholeListSchema = z.array(SpaceWormholeSchema);
const SpaceWormholeDestinationListSchema = z.array(SpaceWormholeDestinationSchema);
const AssignableUsersQuerySchema = z.object({
  search: z.string().optional(),
  exclude_user_ids: z.string().optional(),
});
const RecurringOccurrenceQuerySchema = z.object({
  recurrence_id: z.string().datetime().optional(),
});
const CommentPageQuerySchema = RecurringOccurrenceQuerySchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
});
const OverviewActivityQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const OverviewSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(300),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const SpaceActivitySchema = z.object({
  id: z.string(),
  space: z.object({ id: z.string(), name: z.string(), color: z.string() }),
  item: z.object({ id: z.string(), title: z.string() }).nullable(),
  actor: z.object({
    kind: z.enum(["user", "service_account", "system"]),
    id: z.string().nullable(),
    displayName: z.string(),
    avatarHash: z.string().nullable(),
  }),
  action: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  occurrenceCount: z.number().int(),
  createdAt: z.string(),
  lastOccurredAt: z.string(),
});

const attachmentTooLarge = (c: Context) =>
  respond(c, {
    ok: false,
    error: `File exceeds ${Math.round(MAX_TASK_ATTACHMENT_SIZE_BYTES / 1024 / 1024)} MB limit`,
    status: 413,
  });

const CreateSpaceApiKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  expiresAt: z.string().datetime().nullable().optional(),
  permission: z.enum(["read", "write", "admin"]).default("read"),
});

const CreateSpaceApiKeyResponseSchema = z.object({
  credential: SpaceApiKeySchema,
  token: z.string(),
});

const parseCsv = (value?: string) =>
  value
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean) ?? [];

const parseUuidCsv = (value: string | undefined, label: string): Result<string[]> => {
  const ids = parseCsv(value);
  if (ids.length === 0) return ok([]);
  const parsed = z.array(z.uuid()).safeParse(ids);
  if (!parsed.success) return fail(err.badInput(`Invalid ${label} query parameter.`));
  return ok(parsed.data);
};

const getUserBackedActor = (c: Context<AuthContext>): User | null => {
  const actor = c.get("actor");
  return actor.kind === "user" ? actor.user : actor.delegatedUser;
};

const getSpaceActivityActor = (c: Context<AuthContext>) => {
  const actor = c.get("actor");
  return actor.kind === "user"
    ? ({ kind: "user", id: actor.user.id } as const)
    : ({ kind: "service_account", id: actor.serviceAccount.id } as const);
};

const requireUserBackedActor = (c: Context<AuthContext>): Result<User> => {
  const user = getUserBackedActor(c);
  if (!user) return fail(err.forbidden("This endpoint requires a user-backed actor"));
  return ok(user);
};

const PERMISSION_RANK: Record<PermissionLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

const permissionFromScopes = (scopes: string[]): PermissionLevel => {
  if (scopes.includes("admin")) return "admin";
  if (scopes.includes("write")) return "write";
  if (scopes.includes("read")) return "read";
  return "none";
};

const minPermission = (a: PermissionLevel, b: PermissionLevel): PermissionLevel => (PERMISSION_RANK[a] <= PERMISSION_RANK[b] ? a : b);

const getSpaceAccessSubject = (c: Context<AuthContext>) => {
  const user = getUserBackedActor(c);
  const accessSubject = c.get("accessSubject");
  const actor = c.get("actor");
  const serviceAccount = actor.kind === "service_account" ? actor.serviceAccount : null;
  return {
    user,
    subject: accessSubject,
    serviceAccount,
    serviceAccountScopes: actor.kind === "service_account" ? actor.scopes : [],
  };
};

const getWormholeActor = (c: Context<AuthContext>) => {
  const actor = getSpaceAccessSubject(c);
  return {
    subject: actor.subject,
    resourceBoundSpaceId:
      actor.serviceAccount?.kind === "resource_bound" &&
      actor.serviceAccount.appId === SPACES_APP_ID &&
      actor.serviceAccount.resourceType === SPACE_RESOURCE_TYPE &&
      isSpaceResourceId(actor.serviceAccount.resourceId)
        ? actor.serviceAccount.resourceId
        : null,
  };
};

type ScopedSpaceAccess = {
  subject: AccessSubject;
  boundSpaceId: string | null;
};

const getScopedSpaceAccess = (c: Context<AuthContext>): Result<ScopedSpaceAccess> => {
  const subject = getSpaceAccessSubject(c);

  if (subject.serviceAccount?.kind === "resource_bound") {
    if (
      subject.serviceAccount.appId !== SPACES_APP_ID ||
      subject.serviceAccount.resourceType !== SPACE_RESOURCE_TYPE ||
      !isSpaceResourceId(subject.serviceAccount.resourceId)
    ) {
      return fail(err.forbidden("Access denied"));
    }

    if (!hasPermission(permissionFromScopes(subject.serviceAccountScopes), "read")) {
      return fail(err.forbidden("Access denied"));
    }

    return ok({
      subject: subject.subject,
      boundSpaceId: subject.serviceAccount.resourceId,
    });
  }

  if (subject.subject.type !== "user") return fail(err.forbidden("Access denied"));

  return ok({
    subject: subject.subject,
    boundSpaceId: null,
  });
};

const mailIntegrationRequest = (c: Context<AuthContext>) => ({
  cookie: c.req.header("Cookie"),
  authorization: c.req.header("Authorization"),
  requestId: c.req.header("X-Request-Id") ?? null,
  traceparent: c.req.header("traceparent"),
  tracestate: c.req.header("tracestate"),
  signal: c.req.raw.signal,
});

/**
 * Middleware to check space access with permission level.
 * Global roles never imply resource access; recovery operations use adminApp.
 */
const checkSpaceAccess = async (c: Context<AuthContext>, shortId: string, requiredLevel: PermissionLevel = "read") => {
  const subject = getSpaceAccessSubject(c);
  const spaceId = await resolvePublicId("spaces", shortId);
  if (!spaceId) {
    return {
      space: null,
      internalId: null,
      permission: "none" as PermissionLevel,
      error: await respond(c, fail(err.notFound("Space"))),
    };
  }
  const space = await spacesService.space.get({ id: spaceId });

  if (!space) {
    return {
      space: null,
      internalId: null,
      permission: "none" as PermissionLevel,
      error: await respond(c, fail(err.notFound("Space"))),
    };
  }

  if (
    subject.serviceAccount?.kind === "resource_bound" &&
    (subject.serviceAccount.appId !== SPACES_APP_ID ||
      subject.serviceAccount.resourceType !== SPACE_RESOURCE_TYPE ||
      subject.serviceAccount.resourceId !== spaceId)
  ) {
    return {
      space: null,
      internalId: null,
      permission: "none" as PermissionLevel,
      error: await respond(c, fail(err.forbidden("Access denied"))),
    };
  }

  let permission = await spacesService.space.permission.get({
    spaceId,
    subject: subject.subject,
  });

  if (subject.serviceAccount?.kind === "resource_bound") {
    permission = minPermission(permission, permissionFromScopes(subject.serviceAccountScopes));
  }

  if (!hasPermission(permission, requiredLevel)) {
    return {
      space: null,
      internalId: null,
      permission: "none" as PermissionLevel,
      error: await respond(c, fail(err.forbidden("Access denied"))),
    };
  }

  return { space, internalId: spaceId, permission, user: subject.user };
};

const requireExistingSpace = async (c: Context<AuthContext>, shortId: string) => {
  const spaceId = await resolvePublicId("spaces", shortId);
  if (!spaceId) return { space: null, internalId: null, error: await respond(c, fail(err.notFound("Space"))) };
  const space = await spacesService.space.get({ id: spaceId });
  if (space) return { space, internalId: spaceId, error: null };
  return { space: null, internalId: null, error: await respond(c, fail(err.notFound("Space"))) };
};

/**
 * Wraps mutation results and returns a standardized message payload for API handlers.
 */
const respondMessage = async (c: Context, resultPromise: Promise<Result<void> | MutationResult<void>>, message: string) => {
  return respond(c, async () => {
    const result = await resultPromise;
    if (!result.ok) return result;
    return ok({ message });
  });
};

/**
 * Ensures an item exists and belongs to the requested space before mutation handlers run.
 */
const requireItemInSpace = async (spaceId: string, itemShortId: string) => {
  const itemId = await resolvePublicId("items", itemShortId);
  if (!itemId) return fail(err.notFound("Item"));
  const item = await spacesService.item.get({ id: itemId });
  if (!item || item.spaceId !== spaceId) {
    return fail(err.notFound("Item"));
  }
  return ok(item);
};

const requireColumnInSpace = async (spaceId: string, columnShortId: string) => {
  const columnId = await resolvePublicId("columns", columnShortId);
  if (!columnId) return fail(err.notFound("Column"));
  const column = await spacesService.column.get({ id: columnId });
  if (!column || column.spaceId !== spaceId) {
    return fail(err.notFound("Column"));
  }
  return ok(column);
};

const requireTagInSpace = async (spaceId: string, tagShortId: string) => {
  const tagId = await resolvePublicId("tags", tagShortId);
  if (!tagId) return fail(err.notFound("Tag"));
  const tag = await spacesService.tag.get({ id: tagId });
  if (!tag || tag.spaceId !== spaceId) {
    return fail(err.notFound("Tag"));
  }
  return ok(tag);
};

const projectMutation = async <T extends object>(
  resultPromise: Promise<MutationResult<T>>,
  projector: (items: T[]) => Promise<T[]>,
): Promise<MutationResult<T>> => {
  const result = await resultPromise;
  if (!result.ok) return result;
  const [data] = await projector([result.data]);
  return { ...result, data: data! };
};

const resolveItemData = async <T extends { columnId?: string; recurringEventId?: string | null; tagIds?: string[] }>(
  spaceId: string,
  data: T,
): Promise<Result<T>> => {
  let columnId = data.columnId;
  if (columnId) {
    const column = await requireColumnInSpace(spaceId, columnId);
    if (!column.ok) return column;
    columnId = column.data.id;
  }
  let recurringEventId = data.recurringEventId;
  if (recurringEventId) {
    const recurring = await requireItemInSpace(spaceId, recurringEventId);
    if (!recurring.ok) return recurring;
    recurringEventId = recurring.data.id;
  }
  let tagIds = data.tagIds;
  if (tagIds) {
    const resolved = await resolveSpacePublicIds("tags", spaceId, tagIds);
    if (!resolved) return fail(err.notFound("Tag"));
    tagIds = resolved;
  }
  return ok({ ...data, columnId, recurringEventId, tagIds });
};

const resolveItemFilter = async <T extends { tagIds?: string[]; columnIds?: string[] }>(spaceId: string, filter: T): Promise<Result<T>> => {
  const [tagIds, columnIds] = await Promise.all([
    filter.tagIds ? resolveSpacePublicIds("tags", spaceId, filter.tagIds) : Promise.resolve(undefined),
    filter.columnIds ? resolveSpacePublicIds("columns", spaceId, filter.columnIds) : Promise.resolve(undefined),
  ]);
  if (tagIds === null) return fail(err.notFound("Tag"));
  if (columnIds === null) return fail(err.notFound("Column"));
  return ok({ ...filter, tagIds, columnIds });
};

// Widgets and WebSockets mount before the HTTP auth middleware because both
// own their authentication lifecycle.
import widgetRoutes from "./widgets";

const app = new Hono<AuthContext>()
  .route("/widget", widgetRoutes)
  .route("/ws", wsRoutes)
  .use(auth.requireRole("authenticated"))

  .get(
    "/overview/activity",
    describeRoute({
      tags: ["Spaces"],
      summary: "List Spaces activity",
      description: "List durable activity across every Space the current actor can access.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.object({ data: z.array(SpaceActivitySchema), nextCursor: z.string().nullable() }), "Spaces activity"),
        400: jsonResponse(ErrorResponseSchema, "Invalid cursor"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
      },
    }),
    v("query", OverviewActivityQuerySchema),
    async (c) => {
      const access = getScopedSpaceAccess(c);
      if (!access.ok) return respond(c, access);
      try {
        const page = await spacesService.activity.list({
          subject: access.data.subject,
          boundSpaceId: access.data.boundSpaceId,
          cursor: c.req.valid("query").cursor,
          limit: c.req.valid("query").limit,
        });
        return respond(
          c,
          ok({
            data: page.items.map((item) => ({
              ...item,
              space: { id: item.space.shortId, name: item.space.name, color: item.space.color },
              item: item.item ? { id: item.item.shortId, title: item.item.title } : null,
            })),
            nextCursor: page.nextCursor,
          }),
        );
      } catch (error) {
        if (error instanceof Error && error.message === "Invalid activity cursor") return respond(c, fail(err.badInput(error.message)));
        throw error;
      }
    },
  )

  .get(
    "/overview/search",
    describeRoute({
      tags: ["Spaces"],
      summary: "Search Spaces and items",
      description: "Search accessible Space items for the overview Spotlight.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(
          z.array(z.object({ space: z.object({ id: z.string(), name: z.string() }), item: SpaceItemSchema })),
          "Spaces search results",
        ),
      },
    }),
    v("query", OverviewSearchQuerySchema),
    async (c) => {
      const access = getScopedSpaceAccess(c);
      if (!access.ok) return respond(c, access);
      const hits = await spacesService.item.searchAcross({
        subject: access.data.subject,
        boundSpaceId: access.data.boundSpaceId,
        query: c.req.valid("query").q,
        kinds: "all",
        limit: c.req.valid("query").limit,
      });
      const [items, spaces] = await Promise.all([projectItems(hits.map((hit) => hit.item)), projectSpaces(hits.map((hit) => hit.space))]);
      return respond(c, ok(hits.map((_, index) => ({ item: items[index]!, space: spaces[index]! }))));
    },
  )

  .get(
    "/workspace/view",
    describeRoute({
      tags: ["Spaces"],
      summary: "Refresh the active workspace view",
      description: "Load only the permission-checked list, table, kanban, or calendar snapshot selected by a Spaces URL.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpacesViewSnapshotSchema, "Active workspace view snapshot"),
        400: jsonResponse(ErrorResponseSchema, "Unsupported route"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    v("query", z.object({ href: z.string().min(1).max(3000) })),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const href = c.req.valid("query").href;
      const target = parseSpacesWorkspaceHref(href);
      if (!target) return respond(c, fail(err.badInput("Unsupported workspace view route")));
      const spaceId = await resolvePublicId("spaces", target.spaceId);
      if (!spaceId) return respond(c, fail(err.notFound("Space")));
      const snapshot = await loadSpacesViewSnapshot({
        user: userResult.data,
        spaceId,
        spaceShortId: target.spaceId,
        href,
        cookieHeader: c.req.header("Cookie"),
        authorizationHeader: c.req.header("Authorization"),
        dateConfig: getDateConfig(c),
      });
      if (snapshot.kind === "accessDenied") return respond(c, fail(err.forbidden(snapshot.message)));
      if (snapshot.kind === "notFound") return respond(c, fail(err.notFound("Space")));
      return respond(c, ok(snapshot));
    },
  )

  .get(
    "/:id/settings-context",
    describeRoute({
      tags: ["Spaces"],
      summary: "Get Space settings context",
      description: "Load the current permission-filtered context required by the lazy Space settings dialog.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceSettingsContextSchema, "Space settings context"),
        400: jsonResponse(ErrorResponseSchema, "Invalid identifier"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);

      const spaceShortId = c.req.param("id") ?? "";
      const spaceId = await resolvePublicId("spaces", spaceShortId);
      if (!spaceId) return respond(c, fail(err.notFound("Space")));

      return respond(
        c,
        loadSpaceSettingsContext({
          user: userResult.data,
          spaceId,
          settings: parseSpaceSettings(c.req.header("Cookie"), spaceShortId),
        }),
      );
    },
  )

  .get(
    "/:id/items/:itemId/detail",
    describeRoute({
      tags: ["Spaces"],
      summary: "Get item detail snapshot",
      description: "Load one permission-checked item and its bounded initial comments page for enhanced detail navigation.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceItemDetailSchema, "Item detail snapshot"),
        400: jsonResponse(ErrorResponseSchema, "Invalid identifier"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Item not found"),
      },
    }),
    v("query", RecurringOccurrenceQuerySchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const spaceId = await resolvePublicId("spaces", c.req.param("id") ?? "");
      const itemId = await resolvePublicId("items", c.req.param("itemId") ?? "");
      if (!spaceId || !itemId) return respond(c, fail(err.notFound("Item")));
      const result = await loadSpaceItemDetail({
        user: userResult.data,
        spaceId,
        itemId,
        occurrenceId: c.req.valid("query").recurrence_id,
        dateConfig: getDateConfig(c),
        cookieHeader: c.req.header("Cookie"),
        authorizationHeader: c.req.header("Authorization"),
      });
      if (result.kind === "accessDenied") return respond(c, fail(err.forbidden(result.message)));
      if (result.kind === "notFound") return respond(c, fail(err.notFound("Item")));
      return respond(c, ok(result.detail));
    },
  )
  .get(
    "/:id/items/:itemId/blockers",
    describeRoute({
      tags: ["Spaces"],
      summary: "List task blockers",
      description: "List the bounded tasks that block one task.",
      ...requiresAuth,
      responses: { 200: jsonResponse(SpaceTaskDependencyListSchema, "Task blockers") },
    }),
    async (c) => {
      const access = await checkSpaceAccess(c, c.req.param("id") ?? "", "read");
      if (access.error) return access.error;
      const item = await requireItemInSpace(access.internalId!, c.req.param("itemId") ?? "");
      if (!item.ok) return respond(c, item);
      if (item.data.startsAt || item.data.endsAt) return respond(c, fail(err.badInput("Item is not a task")));
      return respond(c, ok(await projectTaskDependencies(await spacesService.item.dependencies.list({ itemId: item.data.id }))));
    },
  )
  .get(
    "/:id/items/:itemId/blocks",
    describeRoute({
      tags: ["Spaces"],
      summary: "List tasks blocked by a task",
      description: "List the bounded tasks for which this task is a blocker.",
      ...requiresAuth,
      responses: { 200: jsonResponse(SpaceTaskDependentListSchema, "Blocked tasks") },
    }),
    async (c) => {
      const access = await checkSpaceAccess(c, c.req.param("id") ?? "", "read");
      if (access.error) return access.error;
      const item = await requireItemInSpace(access.internalId!, c.req.param("itemId") ?? "");
      if (!item.ok) return respond(c, item);
      if (item.data.startsAt || item.data.endsAt) return respond(c, fail(err.badInput("Item is not a task")));
      return respond(c, ok(await projectTaskDependents(await spacesService.item.dependencies.listBlocks({ blockerItemId: item.data.id }))));
    },
  )
  .get(
    "/:id/items/:itemId/attachments",
    describeRoute({
      tags: ["Spaces"],
      summary: "List task attachments",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceItemAttachmentListSchema, "Task attachments"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Task not found"),
      },
    }),
    async (c) => {
      const access = await checkSpaceAccess(c, c.req.param("id") ?? "", "read");
      if (access.error) return access.error;
      const item = await requireItemInSpace(access.internalId!, c.req.param("itemId") ?? "");
      if (!item.ok) return respond(c, item);
      if (item.data.startsAt || item.data.endsAt) return respond(c, fail(err.badInput("Attachments are only available for tasks")));
      return respond(c, ok(await spacesService.item.attachments.list({ itemId: item.data.id })));
    },
  )
  .post(
    "/:id/items/:itemId/attachments",
    describeRoute({
      tags: ["Spaces"],
      summary: "Upload task attachment",
      description: "Upload one bounded file as multipart form data using the `file` field.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceItemAttachmentSchema, "Uploaded attachment metadata"),
        400: jsonResponse(ErrorResponseSchema, "Invalid file or item"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Task not found"),
        409: jsonResponse(ErrorResponseSchema, "Attachment limit reached"),
        413: jsonResponse(ErrorResponseSchema, "File too large"),
      },
    }),
    bodyLimit({
      maxSize: MAX_TASK_ATTACHMENT_SIZE_BYTES + 64 * 1024,
      onError: attachmentTooLarge,
    }),
    async (c) => {
      const access = await checkSpaceAccess(c, c.req.param("id") ?? "", "write");
      if (access.error) return access.error;
      const item = await requireItemInSpace(access.internalId!, c.req.param("itemId") ?? "");
      if (!item.ok) return respond(c, item);
      if (item.data.startsAt || item.data.endsAt) return respond(c, fail(err.badInput("Attachments are only available for tasks")));

      const contentLength = Number(c.req.header("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_TASK_ATTACHMENT_SIZE_BYTES + 64 * 1024) return attachmentTooLarge(c);
      const form = await c.req.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File)) return respond(c, fail(err.badInput("Missing 'file' field")));
      if (file.size > MAX_TASK_ATTACHMENT_SIZE_BYTES) return attachmentTooLarge(c);

      return respond(
        c,
        spacesService.item.attachments.upload({
          itemId: item.data.id,
          spaceId: access.internalId!,
          filename: file.name || "untitled",
          mimeType: file.type || "application/octet-stream",
          content: new Uint8Array(await file.arrayBuffer()),
          userId: access.user?.id ?? null,
        }),
      );
    },
  )
  .get(
    "/:id/items/:itemId/attachments/:attachmentId/content",
    describeRoute({
      tags: ["Spaces"],
      summary: "Download task attachment",
      ...requiresAuth,
      responses: {
        200: { description: "Attachment content" },
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Attachment not found"),
      },
    }),
    async (c) => {
      const access = await checkSpaceAccess(c, c.req.param("id") ?? "", "read");
      if (access.error) return access.error;
      const item = await requireItemInSpace(access.internalId!, c.req.param("itemId") ?? "");
      if (!item.ok) return respond(c, item);
      const attachment = await spacesService.item.attachments.getContentByShortId({ shortId: c.req.param("attachmentId") ?? "" });
      if (!attachment || attachment.itemId !== item.data.id) return respond(c, fail(err.notFound("Attachment")));

      const inline = attachment.kind === "image" && c.req.query("download") !== "true";
      const contentType = inline ? attachment.mimeType : "application/octet-stream";
      const disposition = `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(attachment.filename)}"`;
      const buffer = attachment.content.buffer.slice(
        attachment.content.byteOffset,
        attachment.content.byteOffset + attachment.content.byteLength,
      ) as ArrayBuffer;
      return new Response(new Blob([buffer], { type: contentType }), {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": disposition,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    },
  )
  .delete(
    "/:id/items/:itemId/attachments/:attachmentId",
    describeRoute({
      tags: ["Spaces"],
      summary: "Delete task attachment",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Attachment deleted"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Attachment not found"),
      },
    }),
    async (c) => {
      const access = await checkSpaceAccess(c, c.req.param("id") ?? "", "write");
      if (access.error) return access.error;
      const item = await requireItemInSpace(access.internalId!, c.req.param("itemId") ?? "");
      if (!item.ok) return respond(c, item);
      return respondMessage(
        c,
        spacesService.item.attachments.remove({
          shortId: c.req.param("attachmentId") ?? "",
          itemId: item.data.id,
          spaceId: access.internalId!,
        }),
        "Attachment deleted",
      );
    },
  )
  .post(
    "/:id/items/:itemId/blockers",
    describeRoute({
      tags: ["Spaces"],
      summary: "Add task blocker",
      description: "Add one same-Space task as an informational blocker.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceTaskDependencySchema, "Task blocker"),
        400: jsonResponse(ErrorResponseSchema, "Invalid dependency"),
        409: jsonResponse(ErrorResponseSchema, "Duplicate, cycle, or dependency limit"),
      },
    }),
    v("json", SpaceTaskDependencyInputSchema),
    async (c) => {
      const access = await checkSpaceAccess(c, c.req.param("id") ?? "", "write");
      if (access.error) return access.error;
      const item = await requireItemInSpace(access.internalId!, c.req.param("itemId") ?? "");
      if (!item.ok) return respond(c, item);
      const blocker = await requireItemInSpace(access.internalId!, c.req.valid("json").blockerItemId);
      if (!blocker.ok) return respond(c, blocker);
      return respond(
        c,
        projectMutation(
          spacesService.item.dependencies.add({
            itemId: item.data.id,
            blockerItemId: blocker.data.id,
            spaceId: access.internalId!,
          }),
          projectTaskDependencies,
        ),
      );
    },
  )
  .delete(
    "/:id/items/:itemId/blockers",
    describeRoute({
      tags: ["Spaces"],
      summary: "Remove task blocker",
      ...requiresAuth,
      responses: { 200: jsonResponse(MessageResponseSchema, "Task blocker removed") },
    }),
    v("json", SpaceTaskDependencyInputSchema),
    async (c) => {
      const access = await checkSpaceAccess(c, c.req.param("id") ?? "", "write");
      if (access.error) return access.error;
      const item = await requireItemInSpace(access.internalId!, c.req.param("itemId") ?? "");
      if (!item.ok) return respond(c, item);
      const blocker = await requireItemInSpace(access.internalId!, c.req.valid("json").blockerItemId);
      if (!blocker.ok) return respond(c, blocker);
      return respondMessage(
        c,
        spacesService.item.dependencies.remove({
          itemId: item.data.id,
          blockerItemId: blocker.data.id,
          spaceId: access.internalId!,
        }),
        "Task blocker removed",
      );
    },
  )
  .get(
    "/:id/items/:itemId/references",
    describeRoute({
      tags: ["Spaces"],
      summary: "List item resource references",
      ...requiresAuth,
      responses: { 200: jsonResponse(SpaceItemResourceReferenceListSchema, "Resource references") },
    }),
    async (c) => {
      const access = await checkSpaceAccess(c, c.req.param("id") ?? "", "read");
      if (access.error) return access.error;
      const item = await requireItemInSpace(access.internalId!, c.req.param("itemId") ?? "");
      if (!item.ok) return respond(c, item);
      return respond(c, ok(await spacesService.item.references.list({ itemId: item.data.id })));
    },
  )
  .post(
    "/:id/items/:itemId/references",
    describeRoute({
      tags: ["Spaces"],
      summary: "Link a Cloud resource to an item",
      ...requiresAuth,
      responses: { 200: jsonResponse(SpaceItemResourceReferenceSchema, "Resource reference") },
    }),
    v("json", SpaceItemResourceReferenceInputSchema),
    async (c) => {
      const access = await checkSpaceAccess(c, c.req.param("id") ?? "", "write");
      if (access.error) return access.error;
      const item = await requireItemInSpace(access.internalId!, c.req.param("itemId") ?? "");
      if (!item.ok) return respond(c, item);
      const reference = await spacesService.item.references.add({
        itemId: item.data.id,
        spaceId: access.internalId!,
        reference: c.req.valid("json"),
      });
      return respond(c, reference ? ok(reference) : fail(err.conflict("Space item already has the maximum number of linked resources")));
    },
  )
  .delete(
    "/:id/items/:itemId/references",
    describeRoute({
      tags: ["Spaces"],
      summary: "Unlink a Cloud resource from an item",
      ...requiresAuth,
      responses: { 200: jsonResponse(ResourceReferenceDeleteResultSchema, "Delete result") },
    }),
    v("json", ResourceReferenceDeleteSchema),
    async (c) => {
      const access = await checkSpaceAccess(c, c.req.param("id") ?? "", "write");
      if (access.error) return access.error;
      const item = await requireItemInSpace(access.internalId!, c.req.param("itemId") ?? "");
      if (!item.ok) return respond(c, item);
      return respond(
        c,
        ok({
          deleted: await spacesService.item.references.remove({
            itemId: item.data.id,
            spaceId: access.internalId!,
            ref: c.req.valid("json").ref,
          }),
        }),
      );
    },
  )

  .get(
    "/:id/items/:itemId/invitation-context",
    describeRoute({
      tags: ["Spaces:Invitations"],
      summary: "Get event invitation context",
      description: "Lists authorized Mail senders and the event's current invitation recipients.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(EventInvitationContextSchema, "Event invitation context"),
        400: jsonResponse(ErrorResponseSchema, "Item is not an event"),
        403: jsonResponse(ErrorResponseSchema, "Write access required"),
        404: jsonResponse(ErrorResponseSchema, "Event not found"),
      },
    }),
    async (c) => {
      const access = await checkSpaceAccess(c, c.req.param("id") ?? "", "write");
      if (access.error) return access.error;
      const spaceId = access.internalId!;
      const item = await requireItemInSpace(spaceId, c.req.param("itemId") ?? "");
      if (!item.ok) return respond(c, item);
      return respond(
        c,
        spacesService.calendarInvitations.getEventInvitationContext({
          spaceId,
          itemId: item.data.id,
          subject: getSpaceAccessSubject(c).subject,
          request: mailIntegrationRequest(c),
        }),
      );
    },
  )

  .post(
    "/:id/items/:itemId/invitation-draft",
    describeRoute({
      tags: ["Spaces:Invitations"],
      summary: "Create an event invitation draft",
      description: "Builds iTIP from the canonical Space event and asks Mail for one idempotent editable draft.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(EventInvitationDraftSchema, "Event invitation draft"),
        400: jsonResponse(ErrorResponseSchema, "Invalid invitation"),
        403: jsonResponse(ErrorResponseSchema, "Write or Mail send access required"),
        404: jsonResponse(ErrorResponseSchema, "Event not found"),
      },
    }),
    v("json", CreateEventInvitationDraftInputSchema),
    async (c) => {
      const access = await checkSpaceAccess(c, c.req.param("id") ?? "", "write");
      if (access.error) return access.error;
      const spaceId = access.internalId!;
      const item = await requireItemInSpace(spaceId, c.req.param("itemId") ?? "");
      if (!item.ok) return respond(c, item);
      return respond(
        c,
        spacesService.calendarInvitations.createEventInvitationDraft({
          spaceId,
          itemId: item.data.id,
          subject: getSpaceAccessSubject(c).subject,
          input: c.req.valid("json"),
          request: mailIntegrationRequest(c),
        }),
      );
    },
  )

  // ==========================
  // List Spaces
  // ==========================
  .get(
    "/",
    describeRoute({
      tags: ["Spaces"],
      summary: "List spaces",
      description: "List all spaces accessible to the current actor.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceListSchema, "List of spaces"),
      },
    }),
    async (c) => {
      const access = getScopedSpaceAccess(c);
      if (!access.ok) return respond(c, access);
      const result = await spacesService.space.list({
        subject: access.data.subject,
        boundSpaceId: access.data.boundSpaceId,
      });
      return respond(c, ok(await projectSpaces(result.items)));
    },
  )

  // ==========================
  // Create Space
  // ==========================
  .post(
    "/",
    describeRoute({
      tags: ["Spaces"],
      summary: "Create space",
      description: "Create a new space. Creator automatically gets admin access.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceSchema, "Created space"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        404: jsonResponse(ErrorResponseSchema, "Group not found"),
      },
    }),
    v("json", CreateSpaceSchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;
      const data = c.req.valid("json");
      return respond(
        c,
        projectMutation(spacesService.space.create({ data, creatorId: user.id, actor: getSpaceActivityActor(c) }), projectSpaces),
      );
    },
  )

  // ==========================
  // Get Space Detail
  // ==========================
  .get(
    "/:id",
    describeRoute({
      tags: ["Spaces"],
      summary: "Get space details",
      description: "Get space with columns and tags.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceDetailSchema, "Space details"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    async (c) => {
      const id = c.req.param("id") ?? "";
      const { internalId, error } = await checkSpaceAccess(c, id);
      if (error) return error;

      const space = await spacesService.space.getDetail({ id: internalId! });
      if (!space) return respond(c, fail(err.notFound("Space")));
      const [projectedSpace, columns, tags] = await Promise.all([
        projectSpaces([space]),
        projectColumns(space.columns),
        projectTags(space.tags),
      ]);
      return respond(c, ok({ ...projectedSpace[0]!, columns, tags }));
    },
  )

  // ==========================
  // Update Space
  // ==========================
  .patch(
    "/:id",
    describeRoute({
      tags: ["Spaces"],
      summary: "Update space",
      description: "Update a space's name, description, or color. Requires write permission.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceSchema, "Updated space"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    v("json", UpdateSpaceSchema),
    async (c) => {
      const id = c.req.param("id") ?? "";
      const data = c.req.valid("json");

      const { internalId, error } = await checkSpaceAccess(c, id, "write");
      if (error) return error;
      return respond(
        c,
        projectMutation(spacesService.space.update({ id: internalId!, data, actor: getSpaceActivityActor(c) }), projectSpaces),
      );
    },
  )

  // ==========================
  // Delete Space
  // ==========================
  .delete(
    "/:id",
    describeRoute({
      tags: ["Spaces"],
      summary: "Delete space",
      description: "Delete a space and all its items. Requires admin permission.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Space deleted"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    async (c) => {
      const id = c.req.param("id") ?? "";

      const { internalId, error } = await checkSpaceAccess(c, id, "admin");
      if (error) return error;
      return respondMessage(c, spacesService.space.remove({ id: internalId! }), "Space deleted");
    },
  )

  // ==========================
  // Regenerate iCal Token
  // ==========================
  .post(
    "/:id/regenerate-ical-token",
    describeRoute({
      tags: ["Spaces"],
      summary: "Regenerate iCal token",
      description: "Generate a new iCal subscription token.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.object({ icalToken: z.string() }), "New iCal token"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    async (c) => {
      const id = c.req.param("id") ?? "";

      const { internalId, error } = await checkSpaceAccess(c, id, "admin");
      if (error) return error;
      return respond(c, spacesService.space.regenerateICalToken({ id: internalId! }));
    },
  )

  // ==========================
  // COLUMNS
  // ==========================

  // Create Column
  .post(
    "/:id/columns",
    describeRoute({
      tags: ["Spaces"],
      summary: "Create column",
      description: "Add a new column to a space.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceColumnSchema, "Created column"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    v("json", CreateColumnSchema),
    async (c) => {
      const spaceShortId = c.req.param("id") ?? "";
      const data = c.req.valid("json");

      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId, "write");
      if (error) return error;
      return respond(c, projectMutation(spacesService.column.create({ spaceId: spaceId!, data }), projectColumns));
    },
  )

  // Update Column
  .patch(
    "/:id/columns/:columnId",
    describeRoute({
      tags: ["Spaces"],
      summary: "Update column",
      description: "Update a column's name, color, or done status.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceColumnSchema, "Updated column"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Column not found"),
      },
    }),
    v("json", UpdateColumnSchema),
    async (c) => {
      const spaceShortId = c.req.param("id") ?? "";
      const columnId = c.req.param("columnId") ?? "";
      const data = c.req.valid("json");

      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId, "write");
      if (error) return error;
      const columnCheck = await requireColumnInSpace(spaceId!, columnId);
      if (!columnCheck.ok) return respond(c, columnCheck);
      return respond(c, projectMutation(spacesService.column.update({ id: columnCheck.data.id, data }), projectColumns));
    },
  )

  // Delete Column
  .delete(
    "/:id/columns/:columnId",
    describeRoute({
      tags: ["Spaces"],
      summary: "Delete column",
      description: "Delete an empty column.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Column deleted"),
        400: jsonResponse(ErrorResponseSchema, "Column has items"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Column not found"),
      },
    }),
    async (c) => {
      const spaceShortId = c.req.param("id") ?? "";
      const columnId = c.req.param("columnId") ?? "";

      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId, "write");
      if (error) return error;
      const columnCheck = await requireColumnInSpace(spaceId!, columnId);
      if (!columnCheck.ok) return respond(c, columnCheck);
      return respondMessage(c, spacesService.column.remove({ id: columnCheck.data.id }), "Column deleted");
    },
  )

  // Reorder Columns
  .put(
    "/:id/columns/order",
    describeRoute({
      tags: ["Spaces"],
      summary: "Reorder columns",
      description: "Set the order of columns in a space.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Columns reordered"),
        400: jsonResponse(ErrorResponseSchema, "Invalid column list"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    v("json", ReorderColumnsSchema),
    async (c) => {
      const spaceShortId = c.req.param("id") ?? "";
      const { columnIds } = c.req.valid("json");

      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId, "write");
      if (error) return error;
      const resolvedColumnIds = await resolveSpacePublicIds("columns", spaceId!, columnIds);
      if (!resolvedColumnIds) return respond(c, fail(err.notFound("Column")));
      return respondMessage(c, spacesService.column.reorder({ spaceId: spaceId!, columnIds: resolvedColumnIds }), "Columns reordered");
    },
  )

  // ==========================
  // WORMHOLES
  // ==========================

  .get(
    "/:id/wormholes",
    describeRoute({
      tags: ["Spaces"],
      summary: "List usable wormholes",
      description: "List wormholes whose source and destination the current actor may write.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceWormholeListSchema, "Usable wormholes"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    async (c) => {
      const { internalId: sourceSpaceId, error } = await checkSpaceAccess(c, c.req.param("id") ?? "", "read");
      if (error) return error;
      return respond(c, async () =>
        ok(await projectWormholes(await spacesService.wormhole.listUsable({ sourceSpaceId: sourceSpaceId!, actor: getWormholeActor(c) }))),
      );
    },
  )

  .get(
    "/:id/wormholes/configured",
    describeRoute({
      tags: ["Spaces"],
      summary: "List configured wormholes",
      description: "List configured wormholes for source-space administrators. Inaccessible destinations are redacted.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceWormholeListSchema, "Configured wormholes"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    async (c) => {
      const { internalId: sourceSpaceId, error } = await checkSpaceAccess(c, c.req.param("id") ?? "", "admin");
      if (error) return error;
      return respond(c, async () => {
        const result = await spacesService.wormhole.listConfigured({ sourceSpaceId: sourceSpaceId!, actor: getWormholeActor(c) });
        if (!result.ok) return result;
        return ok(await projectWormholes(result.data));
      });
    },
  )

  .get(
    "/:id/wormhole-destinations",
    describeRoute({
      tags: ["Spaces"],
      summary: "List wormhole destinations",
      description: "List other spaces and columns where the current actor is also an administrator.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceWormholeDestinationListSchema, "Available destinations"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    async (c) => {
      const { internalId: sourceSpaceId, error } = await checkSpaceAccess(c, c.req.param("id") ?? "", "admin");
      if (error) return error;
      return respond(c, async () => {
        const result = await spacesService.wormhole.listDestinations({ sourceSpaceId: sourceSpaceId!, actor: getWormholeActor(c) });
        if (!result.ok) return result;
        return ok(await projectWormholeDestinations(result.data));
      });
    },
  )

  .post(
    "/:id/wormholes",
    describeRoute({
      tags: ["Spaces"],
      summary: "Create wormhole",
      description: "Create a reusable route to a column in another administered space.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceWormholeSchema, "Created wormhole"),
        400: jsonResponse(ErrorResponseSchema, "Invalid destination"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space or destination not found"),
        409: jsonResponse(ErrorResponseSchema, "Wormhole already exists"),
      },
    }),
    v("json", CreateWormholeSchema),
    async (c) => {
      const { internalId: sourceSpaceId, error } = await checkSpaceAccess(c, c.req.param("id") ?? "", "admin");
      if (error) return error;
      const data = c.req.valid("json");
      const targetColumnId = await resolvePublicId("columns", data.targetColumnId);
      if (!targetColumnId) return respond(c, fail(err.notFound("Destination column")));
      return respond(
        c,
        projectMutation(
          spacesService.wormhole.create({
            sourceSpaceId: sourceSpaceId!,
            data: { ...data, targetColumnId },
            actor: getWormholeActor(c),
          }),
          projectWormholes,
        ),
      );
    },
  )

  .patch(
    "/:id/wormholes/:wormholeId",
    describeRoute({
      tags: ["Spaces"],
      summary: "Update wormhole",
      description: "Update a wormhole destination or color.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceWormholeSchema, "Updated wormhole"),
        400: jsonResponse(ErrorResponseSchema, "Invalid destination"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Wormhole or destination not found"),
        409: jsonResponse(ErrorResponseSchema, "Wormhole already exists"),
      },
    }),
    v("json", UpdateWormholeSchema),
    async (c) => {
      const { internalId: sourceSpaceId, error } = await checkSpaceAccess(c, c.req.param("id") ?? "", "admin");
      if (error) return error;
      const wormholeId = await resolvePublicId("wormholes", c.req.param("wormholeId") ?? "");
      if (!wormholeId) return respond(c, fail(err.notFound("Wormhole")));
      const data = c.req.valid("json");
      const targetColumnId = data.targetColumnId ? ((await resolvePublicId("columns", data.targetColumnId)) ?? undefined) : undefined;
      if (data.targetColumnId && !targetColumnId) return respond(c, fail(err.notFound("Destination column")));
      return respond(
        c,
        projectMutation(
          spacesService.wormhole.update({
            sourceSpaceId: sourceSpaceId!,
            id: wormholeId,
            data: { ...data, targetColumnId },
            actor: getWormholeActor(c),
          }),
          projectWormholes,
        ),
      );
    },
  )

  .put(
    "/:id/wormholes/order",
    describeRoute({
      tags: ["Spaces"],
      summary: "Reorder wormholes",
      description: "Set the display order of every wormhole in a source space.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Wormholes reordered"),
        400: jsonResponse(ErrorResponseSchema, "Invalid wormhole list"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    v("json", ReorderWormholesSchema),
    async (c) => {
      const { internalId: sourceSpaceId, error } = await checkSpaceAccess(c, c.req.param("id") ?? "", "admin");
      if (error) return error;
      const wormholeIds = await resolvePublicIds("wormholes", c.req.valid("json").wormholeIds);
      if (!wormholeIds) return respond(c, fail(err.notFound("Wormhole")));
      return respondMessage(
        c,
        spacesService.wormhole.reorder({
          sourceSpaceId: sourceSpaceId!,
          wormholeIds,
          actor: getWormholeActor(c),
        }),
        "Wormholes reordered",
      );
    },
  )

  .delete(
    "/:id/wormholes/:wormholeId",
    describeRoute({
      tags: ["Spaces"],
      summary: "Delete wormhole",
      description: "Delete a wormhole. Destination access is not required so stale links remain removable.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Wormhole deleted"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Wormhole not found"),
      },
    }),
    async (c) => {
      const { internalId: sourceSpaceId, error } = await checkSpaceAccess(c, c.req.param("id") ?? "", "admin");
      if (error) return error;
      const wormholeId = await resolvePublicId("wormholes", c.req.param("wormholeId") ?? "");
      if (!wormholeId) return respond(c, fail(err.notFound("Wormhole")));
      return respondMessage(
        c,
        spacesService.wormhole.remove({
          sourceSpaceId: sourceSpaceId!,
          id: wormholeId,
          actor: getWormholeActor(c),
        }),
        "Wormhole deleted",
      );
    },
  )

  // ==========================
  // TAGS
  // ==========================

  // Create Tag
  .post(
    "/:id/tags",
    describeRoute({
      tags: ["Spaces"],
      summary: "Create tag",
      description: "Add a new tag to a space.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceTagSchema, "Created tag"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request or duplicate name"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    v("json", CreateTagSchema),
    async (c) => {
      const spaceShortId = c.req.param("id") ?? "";
      const data = c.req.valid("json");

      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId, "write");
      if (error) return error;
      return respond(c, projectMutation(spacesService.tag.create({ spaceId: spaceId!, data }), projectTags));
    },
  )

  // Update Tag
  .patch(
    "/:id/tags/:tagId",
    describeRoute({
      tags: ["Spaces"],
      summary: "Update tag",
      description: "Update a tag's name or color.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceTagSchema, "Updated tag"),
        400: jsonResponse(ErrorResponseSchema, "Duplicate name"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Tag not found"),
      },
    }),
    v("json", UpdateTagSchema),
    async (c) => {
      const spaceShortId = c.req.param("id") ?? "";
      const tagId = c.req.param("tagId") ?? "";
      const data = c.req.valid("json");

      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId, "write");
      if (error) return error;
      const tagCheck = await requireTagInSpace(spaceId!, tagId);
      if (!tagCheck.ok) return respond(c, tagCheck);
      return respond(c, projectMutation(spacesService.tag.update({ id: tagCheck.data.id, data }), projectTags));
    },
  )

  // Delete Tag
  .delete(
    "/:id/tags/:tagId",
    describeRoute({
      tags: ["Spaces"],
      summary: "Delete tag",
      description: "Delete a tag (removes from all items).",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Tag deleted"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Tag not found"),
      },
    }),
    async (c) => {
      const spaceShortId = c.req.param("id") ?? "";
      const tagId = c.req.param("tagId") ?? "";

      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId, "write");
      if (error) return error;
      const tagCheck = await requireTagInSpace(spaceId!, tagId);
      if (!tagCheck.ok) return respond(c, tagCheck);
      return respondMessage(c, spacesService.tag.remove({ id: tagCheck.data.id }), "Tag deleted");
    },
  )

  // ==========================
  // ITEMS
  // ==========================

  // List Items (plain board snapshot)
  .get(
    "/:id/items",
    describeRoute({
      tags: ["Spaces"],
      summary: "List items",
      description: "List all items in a space (board view).",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceItemListSchema, "List of items"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    async (c) => {
      const spaceShortId = c.req.param("id") ?? "";
      const includeCompleted = c.req.query("includeCompleted") === "true";

      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId);
      if (error) return error;

      const result = await spacesService.item.list({ spaceId: spaceId!, includeCompleted });
      return respond(c, ok(await projectItems(result.items)));
    },
  )

  // List Items with filtering, sorting, and pagination
  .post(
    "/:id/items/filter",
    describeRoute({
      tags: ["Spaces"],
      summary: "List items with filters",
      description: "List items with filtering, sorting, and pagination support.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(ItemListResultSchema, "Filtered items with pagination"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    v("json", ItemFilterSchema),
    async (c) => {
      const user = getUserBackedActor(c);
      const spaceShortId = c.req.param("id") ?? "";
      const filter = c.req.valid("json");

      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId);
      if (error) return error;
      const resolvedFilter = await resolveItemFilter(spaceId!, filter);
      if (!resolvedFilter.ok) return respond(c, resolvedFilter);
      const result = await spacesService.item.listFiltered({
        spaceId: spaceId!,
        filter: resolvedFilter.data,
        currentUserId: user?.id,
        dateConfig: getDateConfig(c),
      });
      return respond(c, ok({ ...result, items: await projectItems(result.items) }));
    },
  )

  // List assignable users for assignee pickers
  .get(
    "/:id/assignable-users",
    describeRoute({
      tags: ["Spaces"],
      summary: "List assignable users",
      description:
        "List concrete users that currently have effective access to this space and can be assigned to items. Requires write access, since this is the assignee picker's directory.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceAssignableUserListSchema, "Assignable users"),
        400: jsonResponse(ErrorResponseSchema, "Invalid query"),
        403: jsonResponse(ErrorResponseSchema, "Write access required"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    v("query", AssignableUsersQuerySchema),
    async (c) => {
      const spaceShortId = c.req.param("id") ?? "";
      const query = c.req.valid("query");

      // This is the assignee picker's data source, so it needs the permission
      // that assigning needs. Read access to a space's items is not a reason to
      // be handed a searchable directory of everyone who can see it.
      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId, "write");
      if (error) return error;
      const excludeUserIds = parseUuidCsv(query.exclude_user_ids, "exclude_user_ids");
      if (!excludeUserIds.ok) return respond(c, excludeUserIds);

      const users = await spacesService.item.listAssignableUsers({
        spaceId: spaceId!,
        search: query.search,
        excludeUserIds: excludeUserIds.data,
      });
      return respond(c, ok(users));
    },
  )

  // Create Item
  .post(
    "/:id/items",
    describeRoute({
      tags: ["Spaces"],
      summary: "Create item",
      description: "Create a new item (event, todo, or ticket).",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceItemSchema, "Created item"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        409: jsonResponse(ErrorResponseSchema, "Occurrence override already exists"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    v("json", CreateItemSchema),
    async (c) => {
      const spaceShortId = c.req.param("id") ?? "";
      const data = c.req.valid("json");

      const { internalId: spaceId, user, error } = await checkSpaceAccess(c, spaceShortId, "write");
      if (error) return error;
      const resolvedData = await resolveItemData(spaceId!, data);
      if (!resolvedData.ok) return respond(c, resolvedData);
      return respond(
        c,
        projectMutation(
          spacesService.item.create({
            spaceId: spaceId!,
            data: resolvedData.data,
            createdBy: user?.id ?? null,
            dateConfig: getDateConfig(c),
            actor: getSpaceActivityActor(c),
          }),
          projectItems,
        ),
      );
    },
  )

  // Get Item
  .get(
    "/:id/items/:itemId",
    describeRoute({
      tags: ["Spaces"],
      summary: "Get item",
      description: "Get item details with assignees and tags.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceItemSchema, "Item details"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Item not found"),
      },
    }),
    async (c) => {
      const spaceShortId = c.req.param("id") ?? "";
      const itemId = c.req.param("itemId") ?? "";

      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId);
      if (error) return error;
      const item = await requireItemInSpace(spaceId!, itemId);
      if (!item.ok) return respond(c, item);
      return respond(c, ok((await projectItems([item.data]))[0]!));
    },
  )

  // Update Item
  .patch(
    "/:id/items/:itemId",
    describeRoute({
      tags: ["Spaces"],
      summary: "Update item",
      description: "Update item properties.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceItemSchema, "Updated item"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Item not found"),
      },
    }),
    v("json", UpdateItemSchema),
    async (c) => {
      const spaceShortId = c.req.param("id") ?? "";
      const itemId = c.req.param("itemId") ?? "";
      const data = c.req.valid("json");

      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId, "write");
      if (error) return error;
      const itemCheck = await requireItemInSpace(spaceId!, itemId);
      if (!itemCheck.ok) return respond(c, itemCheck);
      const resolvedData = await resolveItemData(spaceId!, data);
      if (!resolvedData.ok) return respond(c, resolvedData);
      return respond(
        c,
        projectMutation(
          spacesService.item.update({
            id: itemCheck.data.id,
            data: resolvedData.data,
            dateConfig: getDateConfig(c),
            actor: getSpaceActivityActor(c),
          }),
          projectItems,
        ),
      );
    },
  )

  // Split Recurring Item
  .post(
    "/:id/items/:itemId/recurrence/split",
    describeRoute({
      tags: ["Spaces"],
      summary: "Split recurring item",
      description: "Atomically split a recurring series and move future occurrence data to the new series.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceItemSchema, "Created recurring series"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Item or occurrence not found"),
      },
    }),
    v("json", SplitRecurringItemSchema),
    async (c) => {
      const spaceShortId = c.req.param("id") ?? "";
      const itemId = c.req.param("itemId") ?? "";
      const data = c.req.valid("json");

      const { internalId: spaceId, user, error } = await checkSpaceAccess(c, spaceShortId, "write");
      if (error) return error;
      const itemCheck = await requireItemInSpace(spaceId!, itemId);
      if (!itemCheck.ok) return respond(c, itemCheck);
      return respond(
        c,
        projectMutation(
          spacesService.item.splitRecurring({
            id: itemCheck.data.id,
            data,
            createdBy: user?.id ?? null,
            dateConfig: getDateConfig(c),
          }),
          projectItems,
        ),
      );
    },
  )

  // Delete Item
  .delete(
    "/:id/items/:itemId",
    describeRoute({
      tags: ["Spaces"],
      summary: "Delete item",
      description: "Delete an item.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Item deleted"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Item not found"),
      },
    }),
    async (c) => {
      const spaceShortId = c.req.param("id") ?? "";
      const itemId = c.req.param("itemId") ?? "";

      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId, "write");
      if (error) return error;
      const itemCheck = await requireItemInSpace(spaceId!, itemId);
      if (!itemCheck.ok) return respond(c, itemCheck);
      return respondMessage(c, spacesService.item.remove({ id: itemCheck.data.id, actor: getSpaceActivityActor(c) }), "Item deleted");
    },
  )

  // Move Item
  .post(
    "/:id/items/:itemId/move",
    describeRoute({
      tags: ["Spaces"],
      summary: "Move item",
      description: "Move item to a different column/rank (Kanban drag & drop).",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceItemSchema, "Moved item"),
        400: jsonResponse(ErrorResponseSchema, "Invalid column"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Item not found"),
      },
    }),
    v("json", MoveItemSchema),
    async (c) => {
      const spaceShortId = c.req.param("id") ?? "";
      const itemId = c.req.param("itemId") ?? "";
      const { columnId, rank, completed } = c.req.valid("json");

      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId, "write");
      if (error) return error;
      const itemCheck = await requireItemInSpace(spaceId!, itemId);
      if (!itemCheck.ok) return respond(c, itemCheck);
      const column = await requireColumnInSpace(spaceId!, columnId);
      if (!column.ok) return respond(c, column);
      return respond(
        c,
        projectMutation(
          spacesService.item.move({ id: itemCheck.data.id, columnId: column.data.id, rank, completed, actor: getSpaceActivityActor(c) }),
          projectItems,
        ),
      );
    },
  )

  .post(
    "/:id/items/:itemId/wormholes/:wormholeId",
    describeRoute({
      tags: ["Spaces"],
      summary: "Move item through wormhole",
      description: "Atomically transfer an item to the configured destination after rechecking write access to both spaces.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(WormholeTransferResultSchema, "Transferred item"),
        400: jsonResponse(ErrorResponseSchema, "Item cannot be transferred"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Item or wormhole not found"),
        409: jsonResponse(ErrorResponseSchema, "Wormhole destination changed"),
      },
    }),
    async (c) => {
      const { internalId: sourceSpaceId, error } = await checkSpaceAccess(c, c.req.param("id") ?? "", "write");
      if (error) return error;
      const item = await requireItemInSpace(sourceSpaceId!, c.req.param("itemId") ?? "");
      if (!item.ok) return respond(c, item);
      const wormholeId = await resolvePublicId("wormholes", c.req.param("wormholeId") ?? "");
      if (!wormholeId) return respond(c, fail(err.notFound("Wormhole")));
      return respond(c, async () => {
        const result = await spacesService.wormhole.transfer({
          sourceSpaceId: sourceSpaceId!,
          itemId: item.data.id,
          wormholeId,
          actor: getWormholeActor(c),
        });
        if (!result.ok) return result;
        const [projectedItem, projectedDestination] = await Promise.all([
          projectItems([result.data.item]),
          projectWormholeTargets([result.data.destination]),
        ]);
        return ok({
          ...result.data,
          item: projectedItem[0]!,
          destination: projectedDestination[0]!,
        });
      });
    },
  )

  // Set Completed
  .post(
    "/:id/items/:itemId/completed",
    describeRoute({
      tags: ["Spaces"],
      summary: "Set completed status",
      description: "Mark an unblocked item as completed or reopen it and move it to the first matching workflow status when needed.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceItemSchema, "Updated item"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Item not found"),
        409: jsonResponse(ErrorResponseSchema, "Task has active blockers"),
      },
    }),
    v("json", SetCompletedSchema),
    async (c) => {
      const spaceShortId = c.req.param("id") ?? "";
      const itemId = c.req.param("itemId") ?? "";
      const { completed } = c.req.valid("json");

      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId, "write");
      if (error) return error;
      const itemCheck = await requireItemInSpace(spaceId!, itemId);
      if (!itemCheck.ok) return respond(c, itemCheck);
      return respond(
        c,
        projectMutation(
          spacesService.item.setCompleted({ id: itemCheck.data.id, completed, actor: getSpaceActivityActor(c) }),
          projectItems,
        ),
      );
    },
  )

  // ==========================
  // COMMENTS
  // ==========================

  // List Comments
  .get(
    "/:id/items/:itemId/comments",
    describeRoute({
      tags: ["Spaces"],
      summary: "List comments",
      description: "List the newest bounded comment page as a legacy array response.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceCommentListSchema, "List of comments"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Item not found"),
      },
    }),
    v("query", RecurringOccurrenceQuerySchema),
    async (c) => {
      const spaceShortId = c.req.param("id") ?? "";
      const itemId = c.req.param("itemId") ?? "";

      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId);
      if (error) return error;
      const itemCheck = await requireItemInSpace(spaceId!, itemId);
      if (!itemCheck.ok) return respond(c, itemCheck);

      const user = getUserBackedActor(c);
      const result = await spacesService.comment.list({
        itemId: itemCheck.data.id,
        recurrenceId: c.req.valid("query").recurrence_id,
        viewerUserId: user?.id ?? null,
      });
      return respond(c, ok(await projectComments(result.items)));
    },
  )

  .get(
    "/:id/items/:itemId/comments/page",
    describeRoute({
      tags: ["Spaces"],
      summary: "List a comments page",
      description: "List one bounded page of comments, starting with the newest conversation tail.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceCommentPageSchema, "Paginated comments"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Item not found"),
      },
    }),
    v("query", CommentPageQuerySchema),
    async (c) => {
      const spaceShortId = c.req.param("id") ?? "";
      const itemId = c.req.param("itemId") ?? "";
      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId);
      if (error) return error;
      const itemCheck = await requireItemInSpace(spaceId!, itemId);
      if (!itemCheck.ok) return respond(c, itemCheck);
      const query = c.req.valid("query");
      const user = getUserBackedActor(c);
      const result = await spacesService.comment.list({
        itemId: itemCheck.data.id,
        recurrenceId: query.recurrence_id,
        viewerUserId: user?.id ?? null,
        pagination: { page: query.page, perPage: query.per_page },
      });
      return respond(c, ok({ ...result, items: await projectComments(result.items) }));
    },
  )

  // Create Comment
  .post(
    "/:id/items/:itemId/comments",
    describeRoute({
      tags: ["Spaces"],
      summary: "Add comment",
      description: "Add a comment to an item.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceCommentSchema, "Created comment"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Item not found"),
      },
    }),
    v("query", RecurringOccurrenceQuerySchema),
    v("json", CreateCommentSchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;
      const spaceShortId = c.req.param("id") ?? "";
      const itemId = c.req.param("itemId") ?? "";
      const { content } = c.req.valid("json");

      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId, "write");
      if (error) return error;
      const itemCheck = await requireItemInSpace(spaceId!, itemId);
      if (!itemCheck.ok) return respond(c, itemCheck);
      return respond(
        c,
        projectMutation(
          spacesService.comment.create({
            itemId: itemCheck.data.id,
            recurrenceId: c.req.valid("query").recurrence_id,
            dateConfig: getDateConfig(c),
            userId: user.id,
            content,
          }),
          projectComments,
        ),
      );
    },
  )

  // Update Comment
  .patch(
    "/:id/items/:itemId/comments/:commentId",
    describeRoute({
      tags: ["Spaces"],
      summary: "Edit comment",
      description: "Edit your own comment within 10 minutes.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(SpaceCommentSchema, "Updated comment"),
        403: jsonResponse(ErrorResponseSchema, "Cannot edit another user's comment"),
        404: jsonResponse(ErrorResponseSchema, "Comment not found"),
      },
    }),
    v("json", UpdateCommentSchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;
      const spaceShortId = c.req.param("id") ?? "";
      const itemId = c.req.param("itemId") ?? "";
      const commentId = c.req.param("commentId") ?? "";
      const { content } = c.req.valid("json");

      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId, "write");
      if (error) return error;

      // Cross-check the comment is actually in this space's item — owner-check
      // in the service prevents cross-user mutation, but this stops a user
      // from updating their own comment in space B via space A's URL.
      const itemCheck = await requireItemInSpace(spaceId!, itemId);
      if (!itemCheck.ok) return respond(c, itemCheck);
      const internalCommentId = await resolvePublicId("comments", commentId);
      if (!internalCommentId) return respond(c, fail(err.notFound("Comment")));
      const existing = await spacesService.comment.get({ id: internalCommentId, viewerUserId: user.id });
      if (!existing || existing.itemId !== itemCheck.data.id) {
        return respond(c, fail(err.notFound("Comment")));
      }

      return respond(
        c,
        projectMutation(spacesService.comment.update({ id: internalCommentId, content, userId: user.id }), projectComments),
      );
    },
  )

  // Delete Comment
  .delete(
    "/:id/items/:itemId/comments/:commentId",
    describeRoute({
      tags: ["Spaces"],
      summary: "Delete comment",
      description: "Delete your own comment within 10 minutes.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Comment deleted"),
        403: jsonResponse(ErrorResponseSchema, "Cannot delete this comment"),
        404: jsonResponse(ErrorResponseSchema, "Comment not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;
      const spaceShortId = c.req.param("id") ?? "";
      const itemId = c.req.param("itemId") ?? "";
      const commentId = c.req.param("commentId") ?? "";

      const { internalId: spaceId, error } = await checkSpaceAccess(c, spaceShortId, "write");
      if (error) return error;

      // Cross-check (see Update Comment above for rationale).
      const itemCheck = await requireItemInSpace(spaceId!, itemId);
      if (!itemCheck.ok) return respond(c, itemCheck);
      const internalCommentId = await resolvePublicId("comments", commentId);
      if (!internalCommentId) return respond(c, fail(err.notFound("Comment")));
      const existing = await spacesService.comment.get({ id: internalCommentId, viewerUserId: user.id });
      if (!existing || existing.itemId !== itemCheck.data.id) {
        return respond(c, fail(err.notFound("Comment")));
      }

      return respondMessage(
        c,
        spacesService.comment.remove({
          id: internalCommentId,
          userId: user.id,
        }),
        "Comment deleted",
      );
    },
  )

  // ==========================
  // RESOURCE API KEYS
  // ==========================

  .get(
    "/:id/api-keys",
    describeRoute({
      tags: ["Spaces"],
      summary: "List space API keys",
      description: "List active resource-bound API keys for this space. Requires admin permission.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.object({ items: z.array(SpaceApiKeySchema) }), "Space API keys"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);

      const { internalId: spaceId, error } = await checkSpaceAccess(c, c.req.param("id") ?? "", "admin");
      if (error) return error;

      return respond(c, async () => ok({ items: await spacesService.access.apiKeys.list({ spaceId: spaceId! }) }));
    },
  )

  .post(
    "/:id/api-keys",
    describeRoute({
      tags: ["Spaces"],
      summary: "Create space API key",
      description: "Create a resource-bound API key for this space. The raw token is returned once. Requires admin permission.",
      ...requiresAuth,
      responses: {
        201: jsonResponse(CreateSpaceApiKeyResponseSchema, "Space API key created"),
        400: jsonResponse(ErrorResponseSchema, "Failed to create API key"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    v("json", CreateSpaceApiKeySchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;
      const data = c.req.valid("json");
      const { space, internalId: spaceId, error } = await checkSpaceAccess(c, c.req.param("id") ?? "", "admin");
      if (error) return error;

      return respond(
        c,
        spacesService.access.apiKeys.create({
          spaceId: spaceId!,
          actor: user,
          spaceName: space?.name ?? "Space",
          data: {
            name: data.name,
            expiresAt: data.expiresAt,
            permission: data.permission,
          },
        }),
        201,
      );
    },
  )

  .delete(
    "/:id/api-keys/:credentialId",
    describeRoute({
      tags: ["Spaces"],
      summary: "Revoke space API key",
      description: "Revoke a resource-bound API key for this space. Requires admin permission.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Space API key revoked"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "API key not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const user = userResult.data;
      const credentialId = c.req.param("credentialId") ?? "";
      const { internalId: spaceId, error } = await checkSpaceAccess(c, c.req.param("id") ?? "", "admin");
      if (error) return error;

      return respond(c, spacesService.access.apiKeys.revoke({ spaceId: spaceId!, credentialId, actor: user }));
    },
  )

  // ==========================
  // ACCESS CONTROL
  // ==========================

  // List Access Entries
  .get(
    "/:id/access",
    describeRoute({
      tags: ["Spaces"],
      summary: "List access entries",
      description: "List all access entries for a space. Requires admin permission.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.array(AccessEntrySchema), "Access entries"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const { internalId: spaceId, error } = await checkSpaceAccess(c, c.req.param("id") ?? "", "admin");
      if (error) return error;

      const entries = await spacesService.access.list({ spaceId: spaceId! });
      return respond(c, ok(entries.items));
    },
  )

  // Grant Access
  .post(
    "/:id/access",
    describeRoute({
      tags: ["Spaces"],
      summary: "Grant access",
      description: "Grant access to a user, group, or public. Requires admin permission.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(AccessEntrySchema, "Created access entry"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Space, user, or group not found"),
        409: jsonResponse(ErrorResponseSchema, "Principal already has access"),
      },
    }),
    v("json", GrantAccessSchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const { principal, permission } = c.req.valid("json");

      const { internalId: spaceId, error } = await checkSpaceAccess(c, c.req.param("id") ?? "", "admin");
      if (error) return error;
      return respond(
        c,
        spacesService.access.grant({
          spaceId: spaceId!,
          principal,
          permission,
        }),
      );
    },
  )

  // Update Access
  .patch(
    "/:id/access/:accessId",
    describeRoute({
      tags: ["Spaces"],
      summary: "Update access permission",
      description: "Update the permission level for an access entry. Requires admin permission.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Access updated"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Access entry not found"),
      },
    }),
    v("json", UpdateAccessSchema),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const accessId = c.req.param("accessId") ?? "";
      const { permission } = c.req.valid("json");

      const { internalId: spaceId, error } = await checkSpaceAccess(c, c.req.param("id") ?? "", "admin");
      if (error) return error;

      return respondMessage(c, spacesService.access.update({ spaceId: spaceId!, accessId, permission }), "Access updated");
    },
  )

  // Revoke Access
  .delete(
    "/:id/access/:accessId",
    describeRoute({
      tags: ["Spaces"],
      summary: "Revoke access",
      description: "Remove an access entry. Cannot remove the last access entry. Requires admin permission.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Access revoked"),
        400: jsonResponse(ErrorResponseSchema, "Cannot remove last access entry"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Access entry not found"),
      },
    }),
    async (c) => {
      const userResult = requireUserBackedActor(c);
      if (!userResult.ok) return respond(c, userResult);
      const accessId = c.req.param("accessId") ?? "";

      const { internalId: spaceId, error } = await checkSpaceAccess(c, c.req.param("id") ?? "", "admin");
      if (error) return error;

      return respondMessage(c, spacesService.access.remove({ spaceId: spaceId!, accessId }), "Access revoked");
    },
  );

// Global Cloud admins can repair Space ownership and remove abandoned Spaces,
// but this route intentionally exposes no Space content or resource settings.
const adminApp = new Hono<AuthContext>()
  .use(auth.requireRole("admin"))
  .get(
    "/:id/access",
    describeRoute({
      tags: ["Spaces Admin"],
      summary: "List Space access for recovery",
      description: "List access entries without granting access to Space content. Requires Cloud admin.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.array(AccessEntrySchema), "Access entries"),
        403: jsonResponse(ErrorResponseSchema, "Cloud admin required"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    async (c) => {
      const { internalId: spaceId, error } = await requireExistingSpace(c, c.req.param("id") ?? "");
      if (error) return error;
      const entries = await spacesService.access.list({ spaceId: spaceId! });
      return respond(c, ok(entries.items));
    },
  )
  .post(
    "/:id/access",
    describeRoute({
      tags: ["Spaces Admin"],
      summary: "Grant Space access for recovery",
      description: "Grant access without granting the Cloud admin access to Space content. Requires Cloud admin.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(AccessEntrySchema, "Created access entry"),
        403: jsonResponse(ErrorResponseSchema, "Cloud admin required"),
        404: jsonResponse(ErrorResponseSchema, "Space or principal not found"),
        409: jsonResponse(ErrorResponseSchema, "Principal already has access"),
      },
    }),
    v("json", GrantAccessSchema),
    async (c) => {
      const { internalId: spaceId, error } = await requireExistingSpace(c, c.req.param("id") ?? "");
      if (error) return error;
      const { principal, permission } = c.req.valid("json");
      return respond(c, spacesService.access.grant({ spaceId: spaceId!, principal, permission }));
    },
  )
  .patch(
    "/:id/access/:accessId",
    describeRoute({
      tags: ["Spaces Admin"],
      summary: "Update Space access for recovery",
      description: "Update an access entry while preserving at least one Space admin. Requires Cloud admin.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Access updated"),
        400: jsonResponse(ErrorResponseSchema, "Cannot remove the last Space admin"),
        403: jsonResponse(ErrorResponseSchema, "Cloud admin required"),
        404: jsonResponse(ErrorResponseSchema, "Space or access entry not found"),
      },
    }),
    v("json", UpdateAccessSchema),
    async (c) => {
      const { internalId: spaceId, error } = await requireExistingSpace(c, c.req.param("id") ?? "");
      if (error) return error;
      const accessId = c.req.param("accessId") ?? "";
      const { permission } = c.req.valid("json");
      return respondMessage(c, spacesService.access.update({ spaceId: spaceId!, accessId, permission }), "Access updated");
    },
  )
  .delete(
    "/:id/access/:accessId",
    describeRoute({
      tags: ["Spaces Admin"],
      summary: "Revoke Space access for recovery",
      description: "Revoke access while preserving at least one access entry and Space admin. Requires Cloud admin.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Access revoked"),
        400: jsonResponse(ErrorResponseSchema, "Cannot remove the last access entry or Space admin"),
        403: jsonResponse(ErrorResponseSchema, "Cloud admin required"),
        404: jsonResponse(ErrorResponseSchema, "Space or access entry not found"),
      },
    }),
    async (c) => {
      const { internalId: spaceId, error } = await requireExistingSpace(c, c.req.param("id") ?? "");
      if (error) return error;
      const accessId = c.req.param("accessId") ?? "";
      return respondMessage(c, spacesService.access.remove({ spaceId: spaceId!, accessId }), "Access revoked");
    },
  )
  .delete(
    "/:id",
    describeRoute({
      tags: ["Spaces Admin"],
      summary: "Delete an abandoned Space",
      description: "Delete a Space without granting access to its content. Requires Cloud admin.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Space deleted"),
        403: jsonResponse(ErrorResponseSchema, "Cloud admin required"),
        404: jsonResponse(ErrorResponseSchema, "Space not found"),
      },
    }),
    async (c) => {
      const { internalId: spaceId, error } = await requireExistingSpace(c, c.req.param("id") ?? "");
      if (error) return error;
      return respondMessage(c, spacesService.space.remove({ id: spaceId! }), "Space deleted");
    },
  );

// ==========================
// Calendar API (mounted as sub-routes)
// ==========================

const CalendarItemListSchema = z.array(CalendarItemSchema);
const OverlapItemListSchema = z.array(OverlapItemSchema);

const calendarApp = new Hono<AuthContext>()
  .use(auth.requireRole("authenticated"))

  .get(
    "/",
    describeRoute({
      tags: ["Calendar"],
      summary: "List calendar items",
      description: "List all calendar items across all accessible spaces in a date range.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(CalendarItemListSchema, "List of calendar items"),
        400: jsonResponse(z.object({ message: z.string() }), "Invalid date range"),
      },
    }),
    v("query", CalendarQuerySchema),
    async (c) => {
      const access = getScopedSpaceAccess(c);
      if (!access.ok) return respond(c, access);
      const { from, to } = c.req.valid("query");

      const result = await spacesService.item.calendar.list({
        ...access.data,
        from,
        to,
      });
      return respond(c, ok(await projectCalendarItems(result)));
    },
  )

  .get(
    "/overlap",
    describeRoute({
      tags: ["Calendar"],
      summary: "Check time overlap",
      description: "Check if a time range overlaps with existing events.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(OverlapItemListSchema, "List of overlapping items"),
        400: jsonResponse(z.object({ message: z.string() }), "Invalid time range"),
      },
    }),
    v("query", OverlapQuerySchema),
    async (c) => {
      const access = getScopedSpaceAccess(c);
      if (!access.ok) return respond(c, access);
      const { from, to, excludeItemId } = c.req.valid("query");
      const internalExcludeItemId = excludeItemId ? ((await resolvePublicId("items", excludeItemId)) ?? undefined) : undefined;
      if (excludeItemId && !internalExcludeItemId) return respond(c, fail(err.notFound("Item")));

      const result = await spacesService.item.calendar.checkOverlap({
        ...access.data,
        from,
        to,
        excludeItemId: internalExcludeItemId,
      });
      return respond(c, ok(await projectOverlapItems(result)));
    },
  );

// Public iCal feed (no auth required)
const icalApp = new Hono().get(
  "/ical/:filename",
  describeRoute({
    tags: ["Calendar"],
    summary: "iCal feed",
    description: "Public iCal feed for a space (requires valid token).",
    responses: {
      200: {
        description: "iCal content",
        content: {
          "text/calendar": {
            schema: { type: "string" },
          },
        },
      },
      404: jsonResponse(z.object({ message: z.string() }), "Invalid token"),
    },
  }),
  async (c: Context) => {
    const filename = c.req.param("filename");
    const token = filename?.endsWith(".ics") ? filename.slice(0, -4) : filename;

    if (!token) {
      return respond(c, fail(err.notFound("Invalid token")));
    }

    const space = await spacesService.ical.getByToken({ token });
    if (!space) {
      return respond(c, fail(err.notFound("Invalid token")));
    }

    const content = await spacesService.ical.generate({
      spaceId: space.id,
      baseUrl: await coreSettings.get<string>("app.url"),
      dateConfig: getDateConfig(c),
    });

    return c.text(content, 200, {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${space.name}.ics"`,
    });
  },
);

// Combined export: spaces API + calendar sub-routes.
// Calendar is mounted BEFORE the spaces app — `app` has a `/:id` handler that
// would otherwise match the literal path "calendar" as a Space resource route.
// Hono's router
// honours registration order for overlapping static-vs-dynamic paths.
const combined = new Hono()
  .use(rateLimit())
  .route("/admin", adminApp)
  .route("/calendar", calendarApp)
  .route("/calendar", icalApp)
  .route("/", app);

export default combined;
export type ApiType = typeof combined;
