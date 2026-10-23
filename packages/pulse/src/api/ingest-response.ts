import { type AuthContext, fail, jsonResponse, REQUEST_IDLE_TIMEOUT_SECONDS, respond, setRequestTimeout } from "@k2b/cloud/server";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { IngestResult } from "../service/ingest-writer";
import { MessageSchema } from "./schemas";

export const ingestResponses = {
  200: jsonResponse(z.object({ metrics: z.number(), events: z.number(), states: z.number() }), "Ingest counts"),
  400: jsonResponse(MessageSchema, "BAD_INPUT: invalid public ID, telemetry schema, timestamp, or registry cap exceeded"),
  403: jsonResponse(MessageSchema, "Ingest permission required"),
  409: jsonResponse(
    MessageSchema,
    "CONFLICT: idempotency or reset conflict; PULSE_SOURCE_DISABLED: paused source; PULSE_BASE_NOT_WRITABLE: paused base; recovery/storage blocks also return 409",
  ),
  429: jsonResponse(MessageSchema, "Ingest rate limit exceeded; retry after the indicated delay"),
  503: jsonResponse(
    MessageSchema,
    "Quota/store unavailable (Retry-After: 30) or disk low (Retry-After: 300). Retry pending batches with the same Idempotency-Key",
  ),
  404: jsonResponse(MessageSchema, "Unknown ingest source"),
};

// Both ingest routes may make five synchronous inserts with 30-second timeouts.
export const ingestTimeout: MiddlewareHandler<AuthContext> = async (c, next) => {
  setRequestTimeout(c, 240);
  try {
    await next();
  } finally {
    setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
  }
};

export const respondIngest = (c: Context<AuthContext>, result: IngestResult) => {
  if (!result.ok) {
    const error = result.error;
    if ("retryAfter" in error) {
      c.header("Retry-After", String(error.retryAfter));
      return c.json({ code: error.code, message: error.message }, error.status);
    }
    return respond(c, fail(error));
  }
  return respond(c, result);
};
