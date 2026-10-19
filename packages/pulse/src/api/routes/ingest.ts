import { type AuthContext, auth, err, fail, jsonResponse, respond, v } from "@k2b/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { pulseService } from "../../service";
import { IngestBatchSchema, MessageSchema } from "../schemas";

const routes = new Hono<AuthContext>().post(
  "/ingest",
  auth.requireRole("authenticated"),
  describeRoute({
    tags: ["Pulse"],
    summary: "Ingest Pulse metrics, events, and states by source API key",
    responses: {
      200: jsonResponse(z.object({ metrics: z.number(), events: z.number(), states: z.number() }), "Ingest counts"),
      404: jsonResponse(MessageSchema, "Unknown ingest source"),
    },
  }),
  v("json", IngestBatchSchema),
  async (c) => {
    const actor = c.get("actor");
    if (actor.kind !== "service_account") return respond(c, fail(err.forbidden("Pulse ingest requires a resource API key")));
    return respond(
      c,
      pulseService.ingest.byApiKey({
        serviceAccount: actor.serviceAccount,
        scopes: actor.scopes,
        batch: c.req.valid("json"),
        idempotencyKey: c.req.header("idempotency-key"),
      }),
    );
  },
);

export default routes;
