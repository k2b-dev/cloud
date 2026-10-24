import { type AuthContext, auth, jsonResponse, requiresAdmin, resolveDisplayNames, respond, v } from "@k2b/cloud/server";
import { audit } from "@k2b/cloud/services";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { createPagination, ErrorResponseSchema, PaginationQuerySchema, PaginationResponseSchema, parsePagination } from "@/contracts";

const AuditOutcomeSchema = z.enum(["allowed", "denied", "failed"]);
const AuditActionGroupSchema = z.enum(["service_accounts"]);
const FilterTextSchema = z.string().trim().max(200);

const AuditQuerySchema = z.object({
  ...PaginationQuerySchema.shape,
  search: FilterTextSchema.optional(),
  actor: FilterTextSchema.optional(),
  target: FilterTextSchema.optional(),
  action: FilterTextSchema.optional(),
  actionGroup: AuditActionGroupSchema.optional(),
  serviceAccountId: z.uuid().optional(),
  outcome: AuditOutcomeSchema.optional(),
  provider: z.enum(["local", "ipa"]).optional(),
  days: z.coerce.number().int().positive().max(3650).optional(),
});

const AuditEventSchema = z.object({
  id: z.number(),
  createdAt: z.string(),
  action: z.string(),
  outcome: AuditOutcomeSchema,
  actor: z.object({
    userId: z.string().nullable(),
    uid: z.string().nullable(),
    displayName: z
      .string()
      .optional()
      .describe("Current name of a user actor recorded without `uid`; absent when the account no longer exists."),
    provider: z.string().nullable(),
    roles: z.array(z.string()),
  }),
  target: z.object({
    type: z.string().nullable(),
    id: z.string().nullable(),
    label: z.string().nullable(),
    provider: z.string().nullable(),
  }),
  reason: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  requestId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

const AuditListResponseSchema = z.object({
  events: z.array(AuditEventSchema),
  pagination: PaginationResponseSchema,
});

const app = new Hono<AuthContext>().use(auth.requireRole("admin")).get(
  "/",
  describeRoute({
    tags: ["Audit"],
    summary: "List account audit events",
    description: "List Accounts audit events with search and server-side filters.",
    ...requiresAdmin,
    responses: {
      200: jsonResponse(AuditListResponseSchema, "Paginated audit events"),
      401: jsonResponse(ErrorResponseSchema, "Authentication required"),
      403: jsonResponse(ErrorResponseSchema, "Admin access required"),
    },
  }),
  v("query", AuditQuerySchema),
  async (c) => {
    const query = c.req.valid("query");
    const pagination = parsePagination(query);
    const eventsPage = await audit.list({
      pagination: { page: pagination.page, perPage: pagination.perPage },
      filter: {
        search: query.search,
        actor: query.actor,
        target: query.target,
        action: query.action,
        actionGroup: query.actionGroup,
        serviceAccountId: query.serviceAccountId,
        outcome: query.outcome,
        provider: query.provider,
        days: query.days,
      },
    });
    // Some writers record only the actor's user ID; name those actors in one batch.
    const unnamed = [...new Set(eventsPage.items.flatMap((event) => (event.actor.userId && !event.actor.uid ? [event.actor.userId] : [])))];
    const names = new Map(
      (await resolveDisplayNames(unnamed.map((userId) => ({ principal: { type: "user" as const, userId } })))).flatMap((entry) =>
        entry.principal.type === "user" && entry.displayName !== undefined ? [[entry.principal.userId, entry.displayName] as const] : [],
      ),
    );
    return respond(
      c,
      ok({
        events: eventsPage.items.map((event) => {
          const displayName = event.actor.userId && !event.actor.uid ? names.get(event.actor.userId) : undefined;
          return displayName === undefined ? event : { ...event, actor: { ...event.actor, displayName } };
        }),
        pagination: createPagination(pagination, eventsPage.total),
      }),
    );
  },
);

export default app;
