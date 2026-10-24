import { type AuthContext, auth, err, fail, getLocale, respond, v } from "@k2b/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { pulseService } from "../../service";
import { ingestJsonBody, ingestResponses, ingestTimeout, respondIngest } from "../ingest-response";
import { IngestBatchSchema } from "../schemas";

const routes = new Hono<AuthContext>().post(
  "/ingest",
  ingestTimeout,
  auth.requireRole("authenticated"),
  describeRoute({
    tags: ["Pulse"],
    summary: "Ingest Pulse metrics, events, and states by source API key",
    responses: ingestResponses,
  }),
  ingestJsonBody,
  v("json", IngestBatchSchema, () => ({ code: "BAD_INPUT", message: "Invalid ingest batch. Check telemetry fields and types." })),
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
    return respondIngest(c, result);
  },
);

export default routes;
