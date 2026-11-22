import { type AuthContext, auth, err, fail, getLocale, respond } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { pulseService } from "../../service";
import { schemaRejectionReason, serviceRejectionReason } from "../../service/source-rejection-reason";
import { recordIngestRejection } from "../../service/source-rejection-recorder";
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
  // The hook sees the schema issues, so a refusal is recorded for its source without parsing twice.
  validator("json", IngestBatchSchema, (result, c: Context<AuthContext>) => {
    if (result.success) return;
    recordIngestRejection(c.get("actor"), 400, () => schemaRejectionReason(result.error));
    return c.json({ code: "BAD_INPUT", message: "Invalid ingest batch. Check telemetry fields and types." }, 400);
  }),
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
    if (!result.ok) recordIngestRejection(actor, result.error.status, () => serviceRejectionReason(result.error.message));
    return respondIngest(c, result);
  },
);

export default routes;
