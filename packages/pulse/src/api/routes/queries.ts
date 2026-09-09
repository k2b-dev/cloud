import { type AuthContext, jsonResponse, respond, v } from "@k2b/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { pulseService } from "../../service";
import { projectPublicRelations } from "../../service/public-resources";
import {
  CompileTextQuerySchema,
  EventMapQueryTextSchema,
  EventMapResultSchema,
  MetricQueryResultSchema,
  MetricQuerySchema,
  QueryCompileResultSchema,
  QueryTextSchema,
} from "../schemas";
import { projectResult, requestAccessScope, requirePublicIdParam, resolveSourceInput } from "../shared";

const resolveQueryInput = async <T extends { baseId: string }>(input: T) => {
  const base = await requirePublicIdParam(input.baseId, "base ID", "bases");
  if (!base.ok) return base;
  const source = await resolveSourceInput(base.value, input);
  return source.ok ? { ok: true as const, value: { ...source.data, baseId: base.value } } : { ok: false as const, result: source };
};

const routes = new Hono<AuthContext>()
  .post(
    "/query/event-map",
    describeRoute({
      tags: ["Pulse"],
      summary: "Run a Pulse event map query",
      responses: { 200: jsonResponse(EventMapResultSchema, "Map series") },
    }),
    v("json", EventMapQueryTextSchema),
    async (c) => {
      const input = await resolveQueryInput(c.req.valid("json"));
      return input.ok
        ? respond(c, pulseService.query.eventMapText({ ...input.value, user: requestAccessScope(c) }))
        : respond(c, input.result);
    },
  )
  .post(
    "/query/metric",
    describeRoute({
      tags: ["Pulse"],
      summary: "Run a Pulse metric query",
      responses: { 200: jsonResponse(z.array(z.object({ bucket: z.string(), value: z.number().nullable() })), "Query points") },
    }),
    v("json", MetricQuerySchema),
    async (c) => {
      const input = await resolveQueryInput(c.req.valid("json"));
      return input.ok
        ? respond(c, pulseService.query.metric({ kind: "metric", ...input.value }, requestAccessScope(c)))
        : respond(c, input.result);
    },
  )
  .post(
    "/query/metric-text",
    describeRoute({
      tags: ["Pulse"],
      summary: "Run a Pulse query from text DSL",
      responses: { 200: jsonResponse(MetricQueryResultSchema, "Compiled query and results") },
    }),
    v("json", QueryTextSchema),
    async (c) => {
      const input = await resolveQueryInput(c.req.valid("json"));
      return input.ok
        ? respond(c, projectResult(pulseService.query.metricText({ ...input.value, user: requestAccessScope(c) }), projectPublicRelations))
        : respond(c, input.result);
    },
  )
  .post(
    "/query/compile-text",
    describeRoute({
      tags: ["Pulse"],
      summary: "Compile a Pulse query without running it",
      responses: { 200: jsonResponse(QueryCompileResultSchema, "Query diagnostics") },
    }),
    v("json", CompileTextQuerySchema),
    async (c) => {
      const input = await resolveQueryInput(c.req.valid("json"));
      return input.ok
        ? respond(c, projectResult(pulseService.query.compileText({ ...input.value, user: requestAccessScope(c) }), projectPublicRelations))
        : respond(c, input.result);
    },
  );

export default routes;
