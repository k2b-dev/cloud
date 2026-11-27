import { type AuthContext, auth, jsonResponse, rateLimit, requiresAdmin, respond, respondMessage, v } from "@k2b/cloud/server";
import { err, fail, ok } from "@k2b/stdlib";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import {
  CreateOAuthClientSchema,
  createPagination,
  ErrorResponseSchema,
  MessageResponseSchema,
  OAuthClientConnectionParamSchema,
  OAuthClientListQuerySchema,
  OAuthClientListResponseSchema,
  OAuthClientParamSchema,
  OAuthClientSchema,
  OAuthClientWithSecretSchema,
  parsePagination,
  RevokedConnectionsSchema,
  UpdateOAuthClientSchema,
} from "@/contracts";
import { oauthService } from "../service";

// ==========================
// OAuth Admin API
// ==========================

const getUserBackedActor = (c: Context<AuthContext>) => {
  const actor = c.get("actor");
  return actor.kind === "user" ? actor.user : actor.delegatedUser;
};

/**
 * Admin routes for managing OAuth clients
 */
const app = new Hono<AuthContext>()
  .use(rateLimit())
  .use(auth.requireRole("admin"))

  // ==========================
  // List Clients
  // ==========================
  .get(
    "/",
    describeRoute({
      tags: ["OAuth Admin"],
      summary: "List OAuth clients",
      description: "List a filtered page of registered OAuth clients (admin only).",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(OAuthClientListResponseSchema, "Paginated OAuth clients"),
      },
    }),
    v("query", OAuthClientListQuerySchema),
    async (c) => {
      const query = c.req.valid("query");
      const pagination = parsePagination(query);
      const clientsPage = await oauthService.client.list({
        pagination: { page: pagination.page, perPage: pagination.perPage },
        filter: { query: query.search, serviceAccountId: query.serviceAccountId },
      });
      return respond(
        c,
        ok({
          clients: clientsPage.items,
          pagination: createPagination(pagination, clientsPage.total),
        }),
      );
    },
  )

  // ==========================
  // Get Client
  // ==========================
  .get(
    "/:id",
    describeRoute({
      tags: ["OAuth Admin"],
      summary: "Get OAuth client",
      description: "Get details of a specific OAuth client (admin only).",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(OAuthClientSchema, "OAuth client details"),
        400: jsonResponse(ErrorResponseSchema, "Invalid client id"),
        404: jsonResponse(ErrorResponseSchema, "Client not found"),
      },
    }),
    v("param", OAuthClientParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const client = await oauthService.client.get({ id });

      if (!client) {
        return respond(c, fail(err.notFound("Client")));
      }

      return respond(c, ok(client));
    },
  )

  // ==========================
  // Create Client
  // ==========================
  .post(
    "/",
    describeRoute({
      tags: ["OAuth Admin"],
      summary: "Create OAuth client",
      description: "Create a new OAuth client. Returns the client with secret (only shown once).",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(OAuthClientWithSecretSchema, "Created OAuth client with secret"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
      },
    }),
    v("json", CreateOAuthClientSchema),
    async (c) => {
      const data = c.req.valid("json");
      const user = getUserBackedActor(c);
      if (!user) return respond(c, fail(err.forbidden("OAuth client management requires a user-backed actor")));

      const result = await oauthService.client.create({
        data,
        actor: user,
      });

      return respond(c, result);
    },
  )

  // ==========================
  // Update Client
  // ==========================
  .put(
    "/:id",
    describeRoute({
      tags: ["OAuth Admin"],
      summary: "Update OAuth client",
      description: "Update an existing OAuth client (admin only).",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Client updated"),
        400: jsonResponse(ErrorResponseSchema, "Invalid client id"),
        404: jsonResponse(ErrorResponseSchema, "Client not found"),
      },
    }),
    v("param", OAuthClientParamSchema),
    v("json", UpdateOAuthClientSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const data = c.req.valid("json");
      const user = getUserBackedActor(c);
      if (!user) return respond(c, fail(err.forbidden("OAuth client management requires a user-backed actor")));

      return respondMessage(c, oauthService.client.update({ id, data, actor: user }), "Client updated");
    },
  )

  // ==========================
  // Delete Client
  // ==========================
  .delete(
    "/:id",
    describeRoute({
      tags: ["OAuth Admin"],
      summary: "Delete OAuth client",
      description: "Delete an OAuth client (admin only).",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Client deleted"),
        400: jsonResponse(ErrorResponseSchema, "Invalid client id"),
        404: jsonResponse(ErrorResponseSchema, "Client not found"),
      },
    }),
    v("param", OAuthClientParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const user = getUserBackedActor(c);
      if (!user) return respond(c, fail(err.forbidden("OAuth client management requires a user-backed actor")));

      return respondMessage(c, oauthService.client.remove({ id, actor: user }), "Client deleted");
    },
  )

  // ==========================
  // Regenerate Secret
  // ==========================
  .post(
    "/:id/regenerate-secret",
    describeRoute({
      tags: ["OAuth Admin"],
      summary: "Regenerate client secret",
      description: "Regenerate the client secret for a confidential client (admin only).",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(z.object({ clientSecret: z.string() }), "New client secret"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        404: jsonResponse(ErrorResponseSchema, "Client not found"),
      },
    }),
    v("param", OAuthClientParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const user = getUserBackedActor(c);
      if (!user) return respond(c, fail(err.forbidden("OAuth client management requires a user-backed actor")));

      return respond(c, oauthService.client.regenerateSecret({ id, actor: user }));
    },
  )

  // ==========================
  // Disconnect everyone
  // ==========================
  .delete(
    "/:id/connections",
    describeRoute({
      tags: ["OAuth Admin"],
      summary: "Disconnect everyone from an OAuth client",
      description:
        "Revoke every person's refresh tokens for this client and end sign-ins that have not issued tokens yet (admin only). Access tokens already issued run out at their expiry. This ends the current connections and does not block anyone: people the client's access rules allow can connect again (managed clients at the next sign-in, dynamic and first-party clients after confirming consent). To keep someone out, change the client's access rules. Recorded in the audit log.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(RevokedConnectionsSchema, "Number of revoked connections"),
        400: jsonResponse(ErrorResponseSchema, "Invalid client id"),
        404: jsonResponse(ErrorResponseSchema, "Client not found"),
      },
    }),
    v("param", OAuthClientParamSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const user = getUserBackedActor(c);
      if (!user) return respond(c, fail(err.forbidden("OAuth client management requires a user-backed actor")));

      return respond(c, oauthService.client.revokeConnections({ id, userId: null, actor: user }));
    },
  )

  // ==========================
  // Disconnect one person
  // ==========================
  .delete(
    "/:id/connections/:userId",
    describeRoute({
      tags: ["OAuth Admin"],
      summary: "Disconnect a person from an OAuth client",
      description:
        "Revoke one person's refresh tokens for this client and end their sign-ins that have not issued tokens yet (admin only). Access tokens already issued run out at their expiry. This ends the current connections and does not block the person: if the client's access rules allow them, they can connect again (managed clients at the next sign-in, dynamic and first-party clients after confirming consent). To keep them out, change the client's access rules. Recorded in the audit log.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(RevokedConnectionsSchema, "Number of revoked connections"),
        400: jsonResponse(ErrorResponseSchema, "Invalid client or user id"),
        404: jsonResponse(ErrorResponseSchema, "Client not found"),
      },
    }),
    v("param", OAuthClientConnectionParamSchema),
    async (c) => {
      const { id, userId } = c.req.valid("param");
      const user = getUserBackedActor(c);
      if (!user) return respond(c, fail(err.forbidden("OAuth client management requires a user-backed actor")));

      return respond(c, oauthService.client.revokeConnections({ id, userId, actor: user }));
    },
  );

export default app;
export type ApiType = typeof app;
