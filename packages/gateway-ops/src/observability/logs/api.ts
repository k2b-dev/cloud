import { err, fail, ok } from "@k2b/stdlib";
import { type AuthContext, auth, getLocale, jsonResponse, rateLimit, requiresAdmin, respond, v } from "@k2b/cloud/server";
import { get, set } from "@k2b/cloud/services";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { gatewayOpsMessages } from "../../messages";
import {
  createPagination,
  ErrorResponseSchema,
  LogEntrySchema,
  LogLevelSchema,
  PaginationQuerySchema,
  PaginationResponseSchema,
  parsePagination,
} from "./contracts";
import { loggingService } from "./service";

const LogListResponseSchema = z.object({
  entries: z.array(LogEntrySchema),
  pagination: PaginationResponseSchema,
});
const LogSummaryResponseSchema = z.object({
  total: z.number(),
  errors24h: z.number(),
  warnings24h: z.number(),
  total24h: z.number(),
  sources: z.number(),
  lastErrorAt: z.string().nullable(),
});
const LogStatsResponseSchema = z.object({
  groupBy: z.enum(["source", "level"]),
  items: z.array(z.object({ key: z.string(), count: z.number() })),
});
const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;
const LogIdParamSchema = z.object({
  id: z
    .string()
    .regex(/^[1-9]\d*$/)
    .refine((value) => BigInt(value) <= PG_BIGINT_MAX, "Log id must fit into a Postgres BIGINT."),
});

// Mounted at `/api/logging`. Sub-routes:
//   /api/logging/widget/*  — dashboard widget endpoints (own auth)
//   /api/logging/...       — admin api (auth.requireRole("admin"))
import widgetRoutes from "./widgets";

const app = new Hono<AuthContext>()
  .route("/widget", widgetRoutes)
  .use(rateLimit())
  .use(auth.requireRole("admin"))

  // List logs (paginated, filterable)
  .get(
    "/",
    describeRoute({
      tags: ["Logs"],
      summary: "List log entries",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(LogListResponseSchema, "Paginated log entries"),
      },
    }),
    v(
      "query",
      PaginationQuerySchema.extend({
        source: z.string().optional(),
        level: LogLevelSchema.optional(),
        search: z.string().optional(),
        since_hours: z.coerce
          .number()
          .int()
          .positive()
          .max(24 * 31)
          .optional(),
      }),
    ),
    async (c) => {
      const query = c.req.valid("query");
      const pagination = parsePagination(query);

      const { items, total } = await loggingService.entry.list({
        pagination,
        filter: {
          source: query.source,
          level: query.level,
          search: query.search,
          sinceHours: query.since_hours,
        },
      });

      return respond(
        c,
        ok({
          entries: items,
          pagination: createPagination(pagination, total),
        }),
      );
    },
  )

  // Get log volume and error summary
  .get(
    "/summary",
    describeRoute({
      tags: ["Logs"],
      summary: "Get log summary",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(LogSummaryResponseSchema, "Log summary"),
      },
    }),
    async (c) => respond(c, ok(await loggingService.stats.summary())),
  )

  // Get grouped log stats
  .get(
    "/stats",
    describeRoute({
      tags: ["Logs"],
      summary: "Get grouped log stats",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(LogStatsResponseSchema, "Grouped log stats"),
      },
    }),
    v(
      "query",
      z.object({
        group_by: z.enum(["source", "level"]).default("source"),
        since_hours: z.coerce
          .number()
          .int()
          .positive()
          .max(24 * 31)
          .optional(),
        limit: z.coerce.number().int().positive().max(200).optional().default(50),
      }),
    ),
    async (c) => {
      const query = c.req.valid("query");
      const items = await loggingService.stats.by({
        groupBy: query.group_by,
        sinceHours: query.since_hours,
        limit: query.limit,
      });
      return respond(c, ok({ groupBy: query.group_by, items }));
    },
  )

  // Get all unique source names
  .get(
    "/sources",
    describeRoute({
      tags: ["Logs"],
      summary: "List log sources",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(z.object({ sources: z.array(z.string()) }), "List of unique source names"),
      },
    }),
    async (c) => {
      const sources = await loggingService.source.list();
      return respond(c, ok({ sources }));
    },
  )

  // Get one log entry with full metadata
  .get(
    "/:id",
    describeRoute({
      tags: ["Logs"],
      summary: "Get log entry",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(LogEntrySchema, "Log entry"),
        404: jsonResponse(ErrorResponseSchema, "Log entry not found"),
      },
    }),
    v("param", LogIdParamSchema),
    async (c) => {
      const entry = await loggingService.entry.get({ id: c.req.valid("param").id });
      return respond(c, entry ? ok(entry) : fail(err.notFound("Log entry not found")));
    },
  )

  // Cleanup old logs
  .delete(
    "/cleanup",
    describeRoute({
      tags: ["Logs"],
      summary: "Delete old log entries",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(z.object({ deleted: z.number() }), "Number of deleted entries"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
      },
    }),
    v("query", z.object({ days: z.coerce.number().int().min(1).default(30) })),
    async (c) => {
      const { days } = c.req.valid("query");
      return respond(c, loggingService.entry.cleanup({ days }));
    },
  )

  // Get log retention setting
  .get(
    "/settings/retention",
    describeRoute({
      tags: ["Logs"],
      summary: "Get log retention setting",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(z.object({ retentionDays: z.number() }), "Current retention setting"),
      },
    }),
    async (c) => {
      const value = await get<unknown>("logs.retention_days");
      return respond(c, ok({ retentionDays: typeof value === "number" ? value : 30 }));
    },
  )

  // Update log retention setting
  .put(
    "/settings/retention",
    describeRoute({
      tags: ["Logs"],
      summary: "Update log retention setting",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(z.object({ message: z.string() }), "Retention setting updated"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
      },
    }),
    v("json", z.object({ retentionDays: z.coerce.number().int().min(1) })),
    async (c) => {
      const { retentionDays } = c.req.valid("json");
      await set("logs.retention_days", retentionDays);
      return respond(c, ok({ message: gatewayOpsMessages.resolve([getLocale(c)]).t.logRetentionUpdated }));
    },
  );

export default app;
export type ApiType = typeof app;
