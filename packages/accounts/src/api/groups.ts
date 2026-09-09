import { err, fail, ok, type Result } from "@k2b/stdlib";
import { type AuthContext, auth, getLocale, jsonResponse, requiresAdmin, requiresAuth, respond, v } from "@k2b/cloud/server";
import { accountsAppService as accountsService } from "@k2b/cloud/services";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import {
  BaseGroupSchema,
  CreateGroupSchema,
  createPagination,
  ErrorResponseSchema,
  GroupMemberInputSchema,
  MessageResponseSchema,
  PaginationQuerySchema,
  PaginationResponseSchema,
  parsePagination,
  SearchQuerySchema,
  UpdateGroupSchema,
} from "@/contracts";
import { expectUserBackedActor, toAccountsActor } from "@/shared/actor";
import { accountsApiMessages } from "./messages";

const GroupsListResponseSchema = z.object({
  groups: z.array(BaseGroupSchema),
  pagination: PaginationResponseSchema,
});
type BaseGroupResponse = z.infer<typeof BaseGroupSchema>;
type MessageResponse = z.infer<typeof MessageResponseSchema>;
const GroupIdParamSchema = z.object({ id: z.uuid() });

const requireGroupMutationContext = async (c: Context<AuthContext>, groupId: string) => {
  const group = await accountsService.group.get({ id: groupId });
  if (!group) {
    return {
      error: await respond(c, fail(err.notFound("Group not found"))),
    };
  }

  return { group };
};

/**
 * Shared body for the four near-identical add/remove member|manager handlers.
 * Each route only differs in HTTP verb, OpenAPI metadata, the service method
 * called, and a short success-message verb. Keeping the route registrations
 * separate preserves OpenAPI docs; this helper consolidates the body.
 */
type GroupRelationMutation = (config: {
  actor: ReturnType<typeof toAccountsActor>;
  id: string;
  provider: "local" | "ipa";
  userId?: string;
  groupId?: string;
}) => Promise<Result<unknown>>;

const handleGroupRelation = async (
  c: Context<AuthContext>,
  groupId: string,
  input: z.infer<typeof GroupMemberInputSchema>,
  mutation: GroupRelationMutation,
  verbPhrase: string,
) => {
  const { type, id: principalId } = input;
  const { group, error } = await requireGroupMutationContext(c, groupId);
  if (error || !group) return error!;

  return respond(c, async () => {
    const result = await mutation({
      actor: toAccountsActor(expectUserBackedActor(c)),
      id: groupId,
      provider: group.provider,
      userId: type === "user" ? principalId : undefined,
      groupId: type === "group" ? principalId : undefined,
    });
    if (!result.ok) return result;
    return ok({
      message: `${type === "user" ? "User" : "Group"} "${principalId}" ${verbPhrase}.`,
    });
  });
};

/** Group management routes. */
const app = new Hono<AuthContext>()
  // List groups — accessible by all full-account users
  .get(
    "/",
    auth.requireRole("user"),
    describeRoute({
      tags: ["Groups"],
      summary: "List groups",
      description:
        "List groups with pagination and optional search. " + "Use scope=managed, scope=member, or scope=all to choose the current view.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(GroupsListResponseSchema, "Paginated list of groups"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Full account required"),
      },
    }),
    v(
      "query",
      z.object({
        ...PaginationQuerySchema.shape,
        ...SearchQuerySchema.shape,
        scope: z.enum(["managed", "member", "all"]).optional(),
        provider: z.enum(["local", "ipa"]).optional(),
      }),
    ),
    async (c) => {
      const query = c.req.valid("query");
      const params = parsePagination(query);
      const user = expectUserBackedActor(c);

      const groupsPage = await accountsService.group.list({
        pagination: { page: params.page, perPage: params.perPage },
        filter: { search: query.search },
        scope: {
          userId: query.scope === "all" ? undefined : user.id,
          mode: query.scope ?? "member",
          provider: query.provider,
        },
      });

      return respond(
        c,
        ok({
          groups: groupsPage.items,
          pagination: createPagination(params, groupsPage.total),
        }),
      );
    },
  )
  // Add/remove members — accessible by full-account users (backend/provider enforces permissions)
  .post(
    "/:id/members",
    auth.requireRole("user"),
    describeRoute({
      tags: ["Groups"],
      summary: "Add member to group",
      description: "Add a user or group as a member. Admins and group managers can perform this action where allowed.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Member added"),
        400: jsonResponse(ErrorResponseSchema, "Failed to add member"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Group management access required"),
      },
    }),
    v("param", GroupIdParamSchema),
    v("json", GroupMemberInputSchema),
    (c) => handleGroupRelation(c, c.req.valid("param").id, c.req.valid("json"), accountsService.group.member.add, "added as member"),
  )
  .delete(
    "/:id/members",
    auth.requireRole("user"),
    describeRoute({
      tags: ["Groups"],
      summary: "Remove member from group",
      description: "Remove a user or group member. Admins and group managers can perform this action where allowed.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Member removed"),
        400: jsonResponse(ErrorResponseSchema, "Failed to remove member"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Group management access required"),
      },
    }),
    v("param", GroupIdParamSchema),
    v("json", GroupMemberInputSchema),
    (c) => handleGroupRelation(c, c.req.valid("param").id, c.req.valid("json"), accountsService.group.member.remove, "removed"),
  )
  .post(
    "/:id/managers",
    auth.requireRole("admin"),
    describeRoute({
      tags: ["Groups"],
      summary: "Add manager to group",
      description: "Add a user or group as a member manager. This matches FreeIPA and requires admin access.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Manager added"),
        400: jsonResponse(ErrorResponseSchema, "Failed to add manager"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v("param", GroupIdParamSchema),
    v("json", GroupMemberInputSchema),
    (c) => handleGroupRelation(c, c.req.valid("param").id, c.req.valid("json"), accountsService.group.manager.add, "added as manager"),
  )
  .delete(
    "/:id/managers",
    auth.requireRole("admin"),
    describeRoute({
      tags: ["Groups"],
      summary: "Remove manager from group",
      description: "Remove a user or group member manager. This matches FreeIPA and requires admin access.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Manager removed"),
        400: jsonResponse(ErrorResponseSchema, "Failed to remove manager"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v("param", GroupIdParamSchema),
    v("json", GroupMemberInputSchema),
    (c) => handleGroupRelation(c, c.req.valid("param").id, c.req.valid("json"), accountsService.group.manager.remove, "removed as manager"),
  )
  // All routes below require admin role
  .use(auth.requireRole("admin"))
  .post(
    "/",
    describeRoute({
      tags: ["Groups"],
      summary: "Create group",
      description: "Create a new FreeIPA group. Name is normalized to lowercase with hyphens.",
      ...requiresAdmin,
      responses: {
        201: jsonResponse(BaseGroupSchema, "Group created successfully"),
        400: jsonResponse(ErrorResponseSchema, "Invalid input or group already exists"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v("json", CreateGroupSchema),
    async (c) => {
      const { provider, name, description, posix } = c.req.valid("json");

      return respond(
        c,
        async (): Promise<Result<BaseGroupResponse>> =>
          accountsService.group.create({
            actor: toAccountsActor(expectUserBackedActor(c)),
            provider,
            name,
            description,
            posix,
          }),
        201,
      );
    },
  )
  .delete(
    "/:id",
    describeRoute({
      tags: ["Groups"],
      summary: "Delete group",
      description: "Delete a FreeIPA group by name.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Group deleted successfully"),
        400: jsonResponse(ErrorResponseSchema, "Failed to delete group"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v("param", GroupIdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const group = await accountsService.group.get({ id });
      if (!group) return respond(c, fail(err.notFound("Group not found")));

      return respond(c, async () => {
        const result = await accountsService.group.remove({
          actor: toAccountsActor(expectUserBackedActor(c)),
          id,
          provider: group.provider,
        });
        if (!result.ok) return result;
        return ok<MessageResponse>({ message: accountsApiMessages(getLocale(c)).groupDeleted });
      });
    },
  )
  .patch(
    "/:id",
    describeRoute({
      tags: ["Groups"],
      summary: "Update group",
      description: "Update a FreeIPA group's description.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Group updated successfully"),
        400: jsonResponse(ErrorResponseSchema, "Failed to update group"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v("param", GroupIdParamSchema),
    v("json", UpdateGroupSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { description } = c.req.valid("json");
      const group = await accountsService.group.get({ id });
      if (!group) return respond(c, fail(err.notFound("Group not found")));

      return respond(c, async () => {
        const result = await accountsService.group.update({
          actor: toAccountsActor(expectUserBackedActor(c)),
          id,
          provider: group.provider,
          description,
        });
        if (!result.ok) return result;
        return ok<MessageResponse>({ message: accountsApiMessages(getLocale(c)).groupUpdated });
      });
    },
  )
  .put(
    "/:id/posix",
    describeRoute({
      tags: ["Groups"],
      summary: "Convert group to POSIX",
      description: "Convert a FreeIPA group to a POSIX group (assigns a GID). This cannot be undone.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Group converted to POSIX"),
        400: jsonResponse(ErrorResponseSchema, "Failed to convert group"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v("param", GroupIdParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const group = await accountsService.group.get({ id });
      if (!group) return respond(c, fail(err.notFound("Group not found")));

      return respond(c, async () => {
        const result = await accountsService.group.makePosix({
          actor: toAccountsActor(expectUserBackedActor(c)),
          id,
          provider: group.provider,
        });
        if (!result.ok) return result;
        return ok({ message: accountsApiMessages(getLocale(c)).groupConverted });
      });
    },
  );

export default app;
