import {
  type AuthContext,
  auth,
  err,
  fail,
  getLocale,
  jsonResponse,
  ok,
  REQUEST_IDLE_TIMEOUT_SECONDS,
  respond,
  setRequestTimeout,
  v,
} from "@k2b/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { pulseService } from "../../service";
import { IngestBatchSchema, MessageSchema } from "../schemas";

const routes = new Hono<AuthContext>()
  .use("/ingest", async (c, next) => {
    // A batch may make five synchronous store inserts, each with a 30-second timeout.
    setRequestTimeout(c, 240);
    try {
      await next();
    } finally {
      setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
    }
  })
  .post(
    "/ingest",
    auth.requireRole("authenticated"),
    describeRoute({
      tags: ["Pulse"],
      summary: "Ingest Pulse metrics, events, and states by source API key",
      responses: {
        200: jsonResponse(z.object({ metrics: z.number(), events: z.number(), states: z.number() }), "Ingest counts"),
        400: jsonResponse(MessageSchema, "Invalid telemetry, timestamp, or registry cap exceeded"),
        403: jsonResponse(MessageSchema, "Ingest permission required"),
        409: jsonResponse(MessageSchema, "Idempotency conflict, disabled source, or base not writable"),
        429: jsonResponse(MessageSchema, "Ingest rate limit exceeded; retry after the indicated delay"),
        503: jsonResponse(
          MessageSchema,
          "Quota/store unavailable (Retry-After: 30) or disk low (Retry-After: 300). Retry pending batches with the same Idempotency-Key",
        ),
        404: jsonResponse(MessageSchema, "Unknown ingest source"),
      },
    }),
    v("json", IngestBatchSchema),
    async (c) => {
      const actor = c.get("actor");
      if (actor.kind !== "service_account") return respond(c, fail(err.forbidden("Pulse ingest requires a resource API key")));
      const result = await pulseService.ingest.byApiKey({
        serviceAccount: actor.serviceAccount,
        scopes: actor.scopes,
        batch: c.req.valid("json"),
        idempotencyKey: c.req.header("idempotency-key"),
        requestBytes: new TextEncoder().encode(await c.req.text()).byteLength,
        locale: getLocale(c),
      });
      if (!result.ok) {
        const error = result.error;
        if ("retryAfter" in error) {
          c.header("Retry-After", String(error.retryAfter));
          return c.json({ code: error.code, message: error.message }, error.status);
        }
        return respond(c, fail(error));
      }
      return respond(c, ok(result.data));
    },
  );

export default routes;
