import { syncOpsCredentials } from "../sync/service";

/**
 * Background job / trace read API.
 *
 * The trace service has had a full read surface for a while, but until now it
 * was only reachable from the admin page — so background jobs were the one
 * observability domain the CLI could not see at all. These routes expose the
 * same data the page renders: an overview joining schedules with trace stats,
 * the spans of a source, and the events of a single run.
 *
 * Read-only on purpose. Running a schedule now, like every other mutation of
 * background work, goes through the Sync operations API (`../sync/api.ts`),
 * where the owning app audits it.
 */

import { ok } from "@k2b/stdlib";
import { createPagination, parsePagination } from "@k2b/cloud/contracts";
import { type AuthContext, auth, rateLimit, respond, v } from "@k2b/cloud/server";
import { type TraceWindow, trace } from "@k2b/cloud/services";
import { Hono } from "hono";
import { z } from "zod";
import { buildBackgroundJobRows, filterBackgroundJobRows, jobsObservabilityService } from "./service";

const HealthSchema = z.enum(["all", "failed", "stuck", "running", "healthy"]).default("all");
/** Mirrors TraceCategory plus the "all" passthrough the filter accepts. */
const TypeSchema = z.enum(["all", "job", "schedule", "backfill", "ai", "http", "notification", "sync", "custom"]).default("all");

const WindowSchema = z.enum(["10m", "1h", "12h", "24h", "7d", "30d"]).default("24h");

const OverviewQuerySchema = z.object({
  search: z.string().optional(),
  type: TypeSchema,
  health: HealthSchema,
  window: WindowSchema,
});

const StatsQuerySchema = z.object({
  source: z.string().optional(),
  window: WindowSchema,
});

const baseTraceFilter = (window: TraceWindow) => ({ window });

const RunsQuerySchema = z.object({
  source: z.string().optional(),
  window: WindowSchema,
  page: z.coerce.number().int().min(1).optional(),
  per_page: z.coerce.number().int().min(1).max(200).optional(),
});

/** `traceId:spanId`, the same key the admin page puts in its URL. */
const RunKeySchema = z.object({
  run: z.string().regex(/^[0-9a-f]{32}:[0-9a-f]{16}$/, "Run key must be <traceId>:<spanId> in hex."),
});

const parseRunKey = (value: string) => {
  const [traceId, spanId] = value.split(":");
  return { traceId: traceId ?? "", spanId: spanId ?? "" };
};

const app = new Hono<AuthContext>()
  .use(rateLimit())
  .use(auth.requireRole("admin"))

  /** Schedules joined with their trace stats — the "is anything failing" view. */
  .get("/", v("query", OverviewQuerySchema), async (c) => {
    const query = c.req.valid("query");
    // A dead scheduler must degrade to trace-only rows, not fail the request.
    const { schedules, warnings } = await jobsObservabilityService.listSchedules(syncOpsCredentials(c.req.raw)).catch((error) => ({
      schedules: [],
      warnings: [error instanceof Error ? error.message : String(error)],
    }));
    const groups = await trace.sourceGroups({ filter: baseTraceFilter(query.window) });
    const items = filterBackgroundJobRows(buildBackgroundJobRows(schedules, groups), {
      search: query.search,
      type: query.type,
      health: query.health,
    });
    return respond(c, ok({ items, warnings }));
  })

  /** Aggregate run counts and durations across the current trace window. */
  .get("/stats", v("query", StatsQuerySchema), async (c) => {
    const query = c.req.valid("query");
    return respond(c, ok(await trace.stats({ filter: { ...baseTraceFilter(query.window), source: query.source } })));
  })

  /** Individual runs, newest first. Scope with `source` to a single job. */
  .get("/runs", v("query", RunsQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const pagination = parsePagination(query);
    const result = await trace.list(pagination, {
      filter: { ...baseTraceFilter(query.window), source: query.source },
    });
    return respond(c, ok({ items: result.spans, pagination: createPagination(pagination, result.total) }));
  })

  /** One run with its recorded events — the closest thing to a job log. */
  .get("/runs/:run", v("param", RunKeySchema), async (c) => {
    const key = parseRunKey(c.req.valid("param").run);
    const [span, events] = await Promise.all([trace.getSpan(key), trace.events({ ...key, limit: 200 })]);
    return respond(c, ok({ span, events }));
  });

export default app;
