import { ok } from "@k2b/stdlib";
import {
  type AuthContext,
  auth,
  expectUserBackedActor,
  getLocale,
  jsonResponse,
  requiresAdmin,
  respond,
  v,
} from "@k2b/cloud/server";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import {
  createPagination,
  ErrorResponseSchema,
  MessageResponseSchema,
  PaginationQuerySchema,
  PaginationResponseSchema,
  parsePagination,
} from "@/contracts";
import { accountsApiMessages } from "./messages";

const ServiceAccountKindSchema = z.enum(["user_delegated", "resource_bound"]);
const CredentialStatusSchema = z.enum(["active", "revoked"]);
const CredentialIdParamSchema = z.object({ id: z.uuid() });

const ServiceAccountCredentialOverviewSchema = z.object({
  id: z.string(),
  serviceAccountId: z.string(),
  name: z.string(),
  kind: z.literal("api_token"),
  status: CredentialStatusSchema,
  tokenPrefix: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  revokedBy: z.string().nullable(),
  serviceAccount: z.object({
    id: z.string(),
    name: z.string(),
    kind: ServiceAccountKindSchema,
    status: z.enum(["active", "disabled"]),
    delegatedUserId: z.string().nullable(),
    appId: z.string().nullable(),
    resourceType: z.string().nullable(),
    resourceId: z.string().nullable(),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
  }),
  owner: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("user"),
      userId: z.string(),
      uid: z.string(),
      displayName: z.string(),
      mail: z.string().nullable(),
    }),
    z.object({
      type: z.literal("resource"),
      appId: z.string(),
      resourceType: z.string(),
      resourceId: z.string(),
    }),
  ]),
});

const ServiceAccountCredentialsListResponseSchema = z.object({
  credentials: z.array(ServiceAccountCredentialOverviewSchema),
  pagination: PaginationResponseSchema,
});

const QuerySchema = z.object({
  ...PaginationQuerySchema.shape,
  search: z.string().trim().max(200).optional(),
  kind: ServiceAccountKindSchema.optional(),
  status: CredentialStatusSchema.optional(),
  userId: z.uuid().optional(),
});

const app = new Hono<AuthContext>()
  .use(auth.requireRole("admin"))
  .get(
    "/",
    describeRoute({
      tags: ["Service Accounts"],
      summary: "List service account API keys",
      description: "List user-bound and resource-bound service-account API keys with admin filters.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(ServiceAccountCredentialsListResponseSchema, "Paginated service account credentials"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v("query", QuerySchema),
    async (c) => {
      const query = c.req.valid("query");
      const pagination = parsePagination(query);
      const credentialsPage = await serviceAccountCredentials.listOverview({
        pagination: { page: pagination.page, perPage: pagination.perPage },
        filter: {
          search: query.search,
          serviceAccountKind: query.kind,
          credentialStatus: query.status,
          userId: query.userId,
        },
      });

      return respond(
        c,
        ok({
          credentials: credentialsPage.items,
          pagination: createPagination(pagination, credentialsPage.total),
        }),
      );
    },
  )
  .delete(
    "/credentials/:id",
    describeRoute({
      tags: ["Service Accounts"],
      summary: "Revoke a service account API key",
      description: "Revoke an active service-account API key. Revoked keys are retained for audit and observability.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "API key revoked"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
        404: jsonResponse(ErrorResponseSchema, "API key not found"),
      },
    }),
    v("param", CredentialIdParamSchema),
    async (c) => {
      const result = await serviceAccountCredentials.revoke({
        credentialId: c.req.valid("param").id,
        actor: expectUserBackedActor(c),
      });
      if (!result.ok) return respond(c, result);
      return respond(c, ok({ message: accountsApiMessages(getLocale(c)).apiKeyRevoked }));
    },
  );

export default app;
