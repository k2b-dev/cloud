import { err, fail } from "@k2b/stdlib";
import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import {
  createPagination,
  EntityKindSchema,
  EntityListItemSchema,
  ErrorResponseSchema,
  PaginationQuerySchema,
  PaginationResponseSchema,
  parsePagination,
  ServiceAccountKindSchema,
  ServiceAccountStatusSchema,
  UserProfileSchema,
  UserProviderSchema,
} from "../contracts";
import { CloudResourceRefSchema } from "../contracts/capabilities";
import { type AuthContext, auth, getLocale, jsonResponse, requiresAuth, respond, userFromActor, v } from "../server";
import { noTransform } from "../server/middleware/no-transform";
import { ratelimit } from "../server/ratelimit";
import { accountsAppService as accountsService } from "../services";
import { directoryShares } from "../services/accounts/directory-shares";
import * as settings from "../services/settings";
import { managesPrincipalSearchTarget } from "./principal-search-target";

const EntitiesListResponseSchema = z.object({
  items: z.array(EntityListItemSchema),
  pagination: PaginationResponseSchema,
});

const VALID_ENTITY_KINDS = new Set<z.infer<typeof EntityKindSchema>>(EntityKindSchema.options);

const QuerySchema = z
  .object({
    ...PaginationQuerySchema.shape,
    search: z.string().optional(),
    target_type: CloudResourceRefSchema.shape.type
      .optional()
      .describe("Target resource type; Code handle matches require Manage here and target_id."),
    target_id: CloudResourceRefSchema.shape.id.optional().describe("Target resource ID, together with target_type."),
    kinds: z.string().optional(),
    provider: UserProviderSchema.optional(),
    profile: UserProfileSchema.optional(),
    user_ids: z.string().optional(),
    group_ids: z.string().optional(),
    service_account_ids: z.string().optional(),
    service_account_kinds: z.string().optional(),
    service_account_status: ServiceAccountStatusSchema.optional(),
    exclude_user_ids: z.string().optional(),
    exclude_group_ids: z.string().optional(),
    exclude_service_account_ids: z.string().optional(),
    user_member_of_group_ids: z.string().optional(),
    member_of_group_id: z.uuid().optional(),
    manager_of_group_id: z.uuid().optional(),
    parent_group_id: z.uuid().optional(),
    managed_by_user_id: z.uuid().optional(),
    recursive: z.enum(["true", "false"]).optional(),
  })
  .refine((value) => Boolean(value.target_type) === Boolean(value.target_id), {
    message: "A target needs both target_type and target_id.",
    path: ["target_type"],
  })
  .refine(
    (value) => {
      const relationFilters = [value.member_of_group_id, value.manager_of_group_id, value.parent_group_id, value.managed_by_user_id].filter(
        Boolean,
      );
      return relationFilters.length <= 1;
    },
    {
      message: "Only one relation filter can be used at a time.",
      path: ["member_of_group_id"],
    },
  );

const parseCsv = (value?: string) =>
  value
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean) ?? [];

const parseKinds = (value?: string) => {
  const kinds = parseCsv(value);
  if (kinds.length === 0) return { ok: true as const, value: undefined };
  if (kinds.every((kind): kind is z.infer<typeof EntityKindSchema> => VALID_ENTITY_KINDS.has(kind as z.infer<typeof EntityKindSchema>))) {
    return { ok: true as const, value: [...new Set(kinds)] };
  }
  return { ok: false as const, message: "Invalid kinds query parameter." };
};

const parseServiceAccountKinds = (value?: string) => {
  const kinds = parseCsv(value);
  if (kinds.length === 0) return { ok: true as const, value: undefined };
  const parsed = z.array(ServiceAccountKindSchema).safeParse([...new Set(kinds)]);
  if (parsed.success) return { ok: true as const, value: parsed.data };
  return { ok: false as const, message: "Invalid service_account_kinds query parameter." };
};

const parseUuidList = (value: string | undefined, label: string) => {
  const ids = parseCsv(value);
  if (ids.length === 0) return { ok: true as const, value: undefined };
  const parsed = z
    .array(z.uuid())
    .max(100)
    .safeParse([...new Set(ids)]);
  if (parsed.success) {
    return { ok: true as const, value: parsed.data };
  }
  return { ok: false as const, message: `Invalid ${label} query parameter.` };
};

type AccountsEntitiesRouteDependencies = {
  authenticate?: MiddlewareHandler<AuthContext>;
  listEntities?: typeof accountsService.entity.list;
  searchShares?: typeof directoryShares.search;
  managesTarget?: typeof managesPrincipalSearchTarget;
  limitHandleLookup?: (userId: string) => Promise<boolean>;
};

const limitHandleLookup = async (userId: string) => {
  const limit = await settings.get<number>("security.rate_limit_per_second");
  return (await ratelimit({ id: "principal-handle-lookup", limit: Math.max(1, Math.floor(limit)) }).check(userId)).limited;
};

export const createAccountsEntitiesRoutes = (dependencies: AccountsEntitiesRouteDependencies = {}) =>
  new Hono<AuthContext>().use("/entities/*", noTransform()).get(
    "/entities",
    dependencies.authenticate ?? auth.requireRole("authenticated"),
    describeRoute({
      tags: ["Accounts"],
      summary: "List visible directory entries",
      description:
        "List visible users and groups with SQL-backed filtering and pagination. Guest accounts see only themselves and their effective groups; relation filters require a full user account. Standalone and agent accounts with read scope see only explicitly shared directory entries and cannot query relationships. Personal Linux groups are excluded, including exact group IDs and relation filters. Inspect the owning user's Linux identity for diagnostic attributes.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(EntitiesListResponseSchema, "Paginated mixed entity list"),
        429: jsonResponse(z.object({ code: z.literal("RATE_LIMITED"), message: z.string() }), "Handle lookup budget exceeded"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Directory read access required; relation filters require a full user account"),
      },
    }),
    v("query", QuerySchema),
    async (c) => {
      const actor = c.get("actor");
      const user = userFromActor(actor);
      const query = c.req.valid("query");
      const usesRelationFilter = Boolean(
        query.user_member_of_group_ids ||
          query.member_of_group_id ||
          query.manager_of_group_id ||
          query.parent_group_id ||
          query.managed_by_user_id,
      );
      if (user && !user.roles.includes("user") && usesRelationFilter) {
        return respond(c, fail(err.forbidden("Guest accounts cannot use entity relation filters")));
      }
      const params = parsePagination(query);
      const kinds = parseKinds(query.kinds);
      if (!kinds.ok) return respond(c, fail(err.badInput(kinds.message)));
      const serviceAccountKinds = parseServiceAccountKinds(query.service_account_kinds);
      if (!serviceAccountKinds.ok) return respond(c, fail(err.badInput(serviceAccountKinds.message)));
      const excludeUserIds = parseUuidList(query.exclude_user_ids, "exclude_user_ids");
      if (!excludeUserIds.ok) return respond(c, fail(err.badInput(excludeUserIds.message)));
      const excludeGroupIds = parseUuidList(query.exclude_group_ids, "exclude_group_ids");
      if (!excludeGroupIds.ok) return respond(c, fail(err.badInput(excludeGroupIds.message)));
      const excludeServiceAccountIds = parseUuidList(query.exclude_service_account_ids, "exclude_service_account_ids");
      if (!excludeServiceAccountIds.ok) return respond(c, fail(err.badInput(excludeServiceAccountIds.message)));
      const userMemberOfGroupIds = parseUuidList(query.user_member_of_group_ids, "user_member_of_group_ids");
      if (!userMemberOfGroupIds.ok) return respond(c, fail(err.badInput(userMemberOfGroupIds.message)));
      const userIds = parseUuidList(query.user_ids, "user_ids");
      if (!userIds.ok) return respond(c, fail(err.badInput(userIds.message)));
      const groupIds = parseUuidList(query.group_ids, "group_ids");
      if (!groupIds.ok) return respond(c, fail(err.badInput(groupIds.message)));

      const serviceAccountIds = parseUuidList(query.service_account_ids, "service_account_ids");
      if (!serviceAccountIds.ok) return respond(c, fail(err.badInput(serviceAccountIds.message)));

      const filters = {
        search: query.search,
        kinds: kinds.value,
        provider: query.provider,
        profile: query.profile,
        userIds: userIds.value,
        groupIds: groupIds.value,
        serviceAccountIds: serviceAccountIds.value,
        serviceAccountKinds: serviceAccountKinds.value,
        serviceAccountStatus: query.service_account_status,
        excludeUserIds: excludeUserIds.value,
        excludeGroupIds: excludeGroupIds.value,
        excludeServiceAccountIds: excludeServiceAccountIds.value,
        userMemberOfGroupIds: userMemberOfGroupIds.value,
        memberOfGroupId: query.member_of_group_id,
        managerOfGroupId: query.manager_of_group_id,
        parentGroupId: query.parent_group_id,
        managedByUserId: query.managed_by_user_id,
        recursive: query.recursive === "true",
      };
      if (!user) {
        const result = await (dependencies.searchShares ?? directoryShares.search)({
          actor,
          requestId: c.req.header("x-request-id"),
          query: { ...filters, page: params.page, perPage: params.perPage },
        });
        if (!result.ok) return respond(c, result);
        return c.json({ items: result.data.items, pagination: createPagination(params, result.data.total) });
      }
      let codeAccountHandle: string | undefined;
      if (query.search?.trim().startsWith("code-")) {
        if (await (dependencies.limitHandleLookup ?? limitHandleLookup)(user.id))
          return c.json({ code: "RATE_LIMITED", message: "Too many requests" }, 429);
        if (/^code-[0123456789abcdefghjkmnpqrstvwxyz]{10}$/.test(query.search.trim()) && query.target_type && query.target_id) {
          const target = { type: query.target_type, id: query.target_id };
          if (
            await (dependencies.managesTarget ?? managesPrincipalSearchTarget)(target, auth.getAuthority(c), getLocale(c), c.req.raw.signal)
          )
            codeAccountHandle = query.search.trim();
        }
      }
      const result = await (dependencies.listEntities ?? accountsService.entity.list)({
        actor: { userId: user.id, uid: user.uid, roles: user.roles, provider: user.provider },
        pagination: { page: params.page, perPage: params.perPage },
        ...filters,
        codeAccountHandle,
        locale: getLocale(c),
      });

      return respond(c, {
        ok: true,
        data: {
          items: result.items,
          pagination: createPagination(params, result.total),
        },
      });
    },
  );

export default createAccountsEntitiesRoutes();
