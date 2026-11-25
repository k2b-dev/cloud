import {
  type AuthContext,
  auth,
  expectUserBackedActor,
  getLocale,
  jsonResponse,
  middleware,
  rateLimit,
  requiresAdmin,
  respond,
  v,
} from "@k2b/cloud/server";
import { read, settingsService } from "@k2b/cloud/services";
import { err, fail, ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { gatewayOpsMessages } from "../../messages";
import {
  createPagination,
  ErrorResponseSchema,
  LogEntrySchema,
  PaginationQuerySchema,
  PaginationResponseSchema,
  parsePagination,
} from "./contracts";
import { LOG_REQUEST_MAX, LOG_SEARCH_MAX, LOG_SOURCES_MAX, logSearchOf, logsApiParams, logsQuery, parseLogsAddress } from "./query";
import { loggingService } from "./service";

const LogListResponseSchema = z.object({
  entries: z.array(LogEntrySchema),
  pagination: PaginationResponseSchema,
  levels: z.object({ debug: z.number(), info: z.number(), warn: z.number(), error: z.number() }).describe("Matching entries per level"),
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
  .use("*", middleware.noTransform())
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
        time: z
          .string()
          .optional()
          .describe(
            "Time range, as in the page address: a preset (last-15m, last-1h, last-6h, last-24h, last-7d, last-30d) or YYYY-MM-DDTHH:MMZ..YYYY-MM-DDTHH:MMZ (UTC, either end open, at most 31 days); defaults to last-24h",
          ),
        level: z.string().optional().describe("Levels separated by commas: debug, info, warn, error"),
        source: z.string().optional().describe(`Sources separated by commas, at most ${LOG_SOURCES_MAX}`),
        request: z.string().max(LOG_REQUEST_MAX).optional().describe("Part of the metadata, such as a request ID"),
        q: z.string().max(LOG_SEARCH_MAX).optional().describe("Part of the message or the metadata"),
        search: z.string().max(LOG_SEARCH_MAX).optional().describe("Deprecated name of `q`"),
        since_hours: z.coerce
          .number()
          .int()
          .positive()
          .max(24 * 31)
          .optional()
          .describe("Deprecated lookback in hours; `time` replaces it"),
      }),
    ),
    async (c) => {
      const query = c.req.valid("query");
      const pagination = parsePagination(query);
      const { state, issues } = parseLogsAddress(logsQuery("en"), logsApiParams(new URL(c.req.url).searchParams));
      if (issues.length > 0) {
        const parts = issues.map((issue) => `${issue.param || "query"}=${issue.value}`).join(", ");
        return respond(c, fail(err.badInput(`Invalid log filter: ${parts}`)));
      }
      const { entries, total, levels } = await loggingService.entry.search(logSearchOf(state), pagination.page, pagination.perPage);
      return respond(c, ok({ entries, levels, pagination: createPagination(pagination, total) }));
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
    v(
      "query",
      z.object({
        since_hours: z.coerce
          .number()
          .int()
          .positive()
          .max(24 * 31)
          .default(24)
          .describe("Sources that logged within this many hours; defaults to 24"),
      }),
    ),
    async (c) => {
      const sources = await loggingService.source.list(c.req.valid("query").since_hours);
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
        200: jsonResponse(z.object({ retentionDays: z.number(), unreadable: z.boolean() }), "Current retention setting"),
      },
    }),
    async (c) => {
      const state = await read("logs.retention_days");
      return respond(c, ok({ retentionDays: Number(state.value), unreadable: state.stored === "unreadable" }));
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
        409: jsonResponse(
          z.object({ code: z.literal("setting_unreadable"), message: z.string() }),
          "Stored period needs explicit replacement",
        ),
      },
    }),
    v("json", z.object({ retentionDays: z.coerce.number().int().min(1), replaceUnreadable: z.boolean().optional() })),
    async (c) => {
      const { retentionDays, replaceUnreadable } = c.req.valid("json");
      const saved = await settingsService.entry.update({
        key: "logs.retention_days",
        value: retentionDays,
        replaceUnreadable: replaceUnreadable === true,
        audit: {
          action: "settings.update",
          outcome: "allowed",
          actor: { userId: expectUserBackedActor(c).id },
          target: { type: "setting", id: "logs.retention_days" },
        },
      });
      if (!saved.ok) return respond(c, saved);
      return respond(c, ok({ message: gatewayOpsMessages.resolve([getLocale(c)]).t.logRetentionUpdated }));
    },
  );

export default app;
export type ApiType = typeof app;
