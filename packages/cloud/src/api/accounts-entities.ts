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
  UserProfileSchema,
  UserProviderSchema,
} from "../contracts";
import { type AuthContext, auth, expectUserBackedActor, jsonResponse, requiresAuth, respond, v } from "../server";
import { accountsAppService as accountsService } from "../services";

const EntitiesListResponseSchema = z.object({
  items: z.array(EntityListItemSchema),
  pagination: PaginationResponseSchema,
});

const VALID_ENTITY_KINDS = new Set<z.infer<typeof EntityKindSchema>>(EntityKindSchema.options);

const QuerySchema = z
  .object({
    ...PaginationQuerySchema.shape,
    search: z.string().optional(),
    kinds: z.string().optional(),
    provider: UserProviderSchema.optional(),
    profile: UserProfileSchema.optional(),
    user_ids: z.string().optional(),
    group_ids: z.string().optional(),
    exclude_user_ids: z.string().optional(),
    exclude_group_ids: z.string().optional(),
    exclude_service_account_ids: z.string().optional(),
    user_member_of_group_ids: z.string().optional(),
    member_of_group_id: z.uuid().optional(),
    manager_of_group_id: z.uuid().optional(),
    parent_group_id: z.uuid().optional(),
    managed_by_user_id: z.uuid().optional(),
    recursive: z.enum(["true", "false"]).optional(),
    include_personal: z.enum(["true", "false"]).optional(),
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
  requireUser?: MiddlewareHandler<AuthContext>;
  listEntities?: typeof accountsService.entity.list;
};

export const createAccountsEntitiesRoutes = (dependencies: AccountsEntitiesRouteDependencies = {}) =>
  new Hono<AuthContext>().get(
    "/entities",
    dependencies.authenticate ?? auth.requireRole("authenticated"),
    dependencies.requireUser ?? auth.requireUser(),
    describeRoute({
      tags: ["Accounts"],
      summary: "List mixed users and groups",
      description:
        "List visible users and groups with SQL-backed filtering and pagination. Guest accounts see only themselves and their effective groups; relation filters require a full user account. Personal Linux groups (a user's private primary group, flagged with `personalOwner`) are left out unless `include_personal=true`; exact `group_ids` lookups and relation filters always return them.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(EntitiesListResponseSchema, "Paginated mixed entity list"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "User-backed account required; relation filters require a full account"),
      },
    }),
    v("query", QuerySchema),
    async (c) => {
      const user = expectUserBackedActor(c);
      const query = c.req.valid("query");
      const usesRelationFilter = Boolean(
        query.user_member_of_group_ids ||
          query.member_of_group_id ||
          query.manager_of_group_id ||
          query.parent_group_id ||
          query.managed_by_user_id,
      );
      if (!user.roles.includes("user") && usesRelationFilter) {
        return respond(c, fail(err.forbidden("Guest accounts cannot use entity relation filters")));
      }
      const params = parsePagination(query);
      const kinds = parseKinds(query.kinds);
      if (!kinds.ok) return respond(c, fail(err.badInput(kinds.message)));
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

      const result = await (dependencies.listEntities ?? accountsService.entity.list)({
        actor: {
          userId: user.id,
          uid: user.uid,
          roles: user.roles,
          provider: user.provider,
        },
        pagination: { page: params.page, perPage: params.perPage },
        search: query.search,
        kinds: kinds.value,
        provider: query.provider,
        profile: query.profile,
        userIds: userIds.value,
        groupIds: groupIds.value,
        excludeUserIds: excludeUserIds.value,
        excludeGroupIds: excludeGroupIds.value,
        excludeServiceAccountIds: excludeServiceAccountIds.value,
        userMemberOfGroupIds: userMemberOfGroupIds.value,
        memberOfGroupId: query.member_of_group_id,
        managerOfGroupId: query.manager_of_group_id,
        parentGroupId: query.parent_group_id,
        managedByUserId: query.managed_by_user_id,
        recursive: query.recursive === "true",
        includePersonal: query.include_personal === "true",
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
