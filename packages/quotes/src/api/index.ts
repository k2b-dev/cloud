import { Hono } from "hono";
import { rateLimit } from "@k2b/cloud/server";
import { describeRoute } from "hono-openapi";
import { jsonResponse } from "@k2b/cloud/server";
import { respond } from "@k2b/cloud/server";
import { quotesService } from "../service";
import { z } from "zod";

const QuoteSchema = z.object({
  text: z.string(),
  author: z.string(),
});

const ErrorResponseSchema = z.object({
  message: z.string(),
});

/** Quotes API routes — public, no auth required. */
//
// Mounted at `/api/quotes`. Sub-routes:
//   /api/quotes/widget/*  — dashboard widget endpoint
//   /api/quotes/...       — public quote-of-the-hour endpoint
import widgetRoutes from "./widgets";

const app = new Hono()
  .route("/widget", widgetRoutes)
  .use(rateLimit())
  .get(
    "/",
    describeRoute({
      tags: ["Quotes"],
      summary: "Get quote of the hour",
      description: "Get a random inspirational quote. Quotes are cached for 1 hour.",
      responses: {
        200: jsonResponse(QuoteSchema, "Quote data"),
        500: jsonResponse(ErrorResponseSchema, "Failed to fetch quote"),
      },
    }),
    async (c) => {
      return respond(c, quotesService.quote.get());
    },
  );

export default app;
export type ApiType = typeof app;
