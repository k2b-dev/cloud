import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { createPagination, ErrorResponseSchema, MessageResponseSchema, PaginationQuerySchema, parsePagination } from "../contracts";
import { type AuthContext, auth, jsonResponse, requiresAdmin, respond, v } from "../server";
import { accountLifecycle, lifecycleJobs } from "../services";

const DeletedAccountSchema = z.object({
  id: z.uuid(),
  deletedUserId: z.uuid(),
  uid: z.string(),
  mail: z.string().nullable(),
  displayName: z.string().nullable(),
  previousProvider: z.string().nullable(),
  previousProfile: z.string().nullable(),
  reason: z.string(),
  deletedAt: z.string().datetime(),
  meta: z.record(z.string(), z.unknown()),
});

const ReminderAuditSchema = z.object({
  id: z.uuid(),
  userId: z.uuid().nullable(),
  uid: z.string().nullable(),
  mail: z.string().nullable(),
  displayName: z.string().nullable(),
  kind: z.enum(["account_expiry"]),
  thresholdDays: z.number().int().positive(),
  targetExpiryAt: z.string().datetime(),
  status: z.enum(["pending", "sent", "error"]),
  attemptCount: z.number().int().nonnegative(),
  lastAttemptAt: z.string().datetime().nullable(),
  sentAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
});

const DeletedAccountsResponseSchema = z.object({
  items: z.array(DeletedAccountSchema),
  pagination: z.object({
    page: z.number(),
    per_page: z.number(),
    total: z.number(),
    total_pages: z.number(),
    has_next: z.boolean(),
  }),
});

const ReminderAuditResponseSchema = z.object({
  items: z.array(ReminderAuditSchema),
  pagination: z.object({
    page: z.number(),
    per_page: z.number(),
    total: z.number(),
    total_pages: z.number(),
    has_next: z.boolean(),
  }),
});

const TriggerJobResponseSchema = z.object({
  message: z.string(),
  jobId: z.string(),
});

const app = new Hono<AuthContext>()
  .use(auth.requireRole("admin"))
  .get(
    "/deleted-accounts",
    describeRoute({
      tags: ["Admin Lifecycle"],
      summary: "List deleted account lifecycle entries",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(DeletedAccountsResponseSchema, "Deleted account lifecycle entries"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v(
      "query",
      z.object({
        ...PaginationQuerySchema.shape,
        reason: z.string().optional(),
        search: z.string().optional(),
      }),
    ),
    async (c) => {
      const query = c.req.valid("query");
      const pagination = parsePagination(query);
      const result = await accountLifecycle.listDeletedAccounts({
        page: pagination.page,
        perPage: pagination.perPage,
        reason: query.reason,
        search: query.search,
      });

      return c.json({
        items: result.items,
        pagination: createPagination(pagination, result.total),
      });
    },
  )
  .get(
    "/reminders",
    describeRoute({
      tags: ["Admin Lifecycle"],
      summary: "List reminder history entries",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(ReminderAuditResponseSchema, "Reminder history entries"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v(
      "query",
      z.object({
        ...PaginationQuerySchema.shape,
        status: z.enum(["pending", "sent", "error"]).optional(),
        kind: z.enum(["account_expiry"]).optional(),
        search: z.string().optional(),
      }),
    ),
    async (c) => {
      const query = c.req.valid("query");
      const pagination = parsePagination(query);
      const result = await accountLifecycle.listReminderAudit({
        page: pagination.page,
        perPage: pagination.perPage,
        status: query.status,
        kind: query.kind,
        search: query.search,
      });

      return c.json({
        items: result.items,
        pagination: createPagination(pagination, result.total),
      });
    },
  )
  // Manual-only lifecycle jobs. Scheduled jobs such as IPA sync and reminders
  // run from their broker schedules; Admin Observability Jobs can run them now.
  .post(
    "/jobs",
    describeRoute({
      tags: ["Admin Lifecycle"],
      summary: "Submit a lifecycle job",
      description:
        "Dispatches one of the account-lifecycle backfill jobs. Scheduled lifecycle jobs are controlled from Admin Observability Jobs.",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(TriggerJobResponseSchema, "Job submitted"),
        400: jsonResponse(ErrorResponseSchema, "Unknown job kind"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    v(
      "json",
      z.object({
        kind: z.enum(["ipa-backfill", "local-user-backfill", "guest-backfill"]),
      }),
    ),
    async (c) =>
      respond(c, async () => {
        const { kind } = c.req.valid("json");
        switch (kind) {
          case "ipa-backfill":
            return ok({ message: "IPA backfill job submitted", jobId: await lifecycleJobs.submitIpaBackfill() });
          case "local-user-backfill":
            return ok({ message: "Local user backfill job submitted", jobId: await lifecycleJobs.submitLocalUserBackfill() });
          case "guest-backfill":
            return ok({ message: "Local guest backfill job submitted", jobId: await lifecycleJobs.submitGuestBackfill() });
        }
      }),
  )
  .get(
    "/health",
    describeRoute({
      tags: ["Admin Lifecycle"],
      summary: "Lifecycle worker metrics",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(z.object({ metrics: z.record(z.string(), z.unknown()) }), "Process-local worker metrics"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        403: jsonResponse(ErrorResponseSchema, "Admin access required"),
      },
    }),
    async (c) => c.json({ metrics: lifecycleJobs.metrics() }),
  )
  .get(
    "/",
    describeRoute({
      tags: ["Admin Lifecycle"],
      summary: "Lifecycle API root",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "Lifecycle API available"),
      },
    }),
    (c) => c.json({ message: "Account lifecycle admin API" }),
  );

export default app;
export type ApiType = typeof app;
