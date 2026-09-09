import { ok, type Result } from "@k2b/stdlib";
import { type AuthContext, auth, getLocale, jsonResponse, rateLimit, requiresAdmin, respond, v } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import {
  CreateFaqSchema,
  ErrorResponseSchema,
  FaqEntrySchema,
  MessageResponseSchema,
  ReorderFaqSchema,
  UpdateFaqSchema,
} from "@/contracts";
import { faqService } from "../service";
import { faqApiErrorMessage, faqServiceMessages } from "../service/messages";

const withMessage = async (operation: Promise<Result<unknown>>, message: string) => {
  const result = await operation;
  if (!result.ok) return result;
  return ok({ message });
};

const localizeApiError = async (c: Context, next: () => Promise<void>) => {
  await next();
  if (c.res.status < 400 || !c.res.headers.get("content-type")?.includes("application/json")) return;
  const body: unknown = await c.res
    .clone()
    .json()
    .catch(() => null);
  if (!body || typeof body !== "object" || !("message" in body) || typeof body.message !== "string") return;
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  c.res = new Response(JSON.stringify({ ...body, message: faqApiErrorMessage(c.res.status, getLocale(c), body.message) }), {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
};

const app = new Hono<AuthContext>()
  .use(rateLimit())
  .use(localizeApiError)
  .use(auth.requireRole("admin"))

  // List all FAQs
  .get(
    "/",
    describeRoute({
      tags: ["FAQ"],
      summary: "List all FAQ entries",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(z.object({ entries: z.array(FaqEntrySchema) }), "All FAQ entries"),
      },
    }),
    async (c) => {
      const entries = await faqService.entry.list();
      return respond(c, ok({ entries: entries.items }));
    },
  )

  // Create FAQ
  .post(
    "/",
    describeRoute({
      tags: ["FAQ"],
      summary: "Create FAQ entry",
      ...requiresAdmin,
      responses: {
        201: jsonResponse(FaqEntrySchema, "Created FAQ entry"),
        400: jsonResponse(ErrorResponseSchema, "Validation error"),
      },
    }),
    v("json", CreateFaqSchema, (c) => ({ code: "BAD_INPUT", message: faqServiceMessages(getLocale(c)).invalidRequest })),
    async (c) => {
      const input = c.req.valid("json");
      return respond(c, faqService.entry.create({ data: input, locale: getLocale(c) }), 201);
    },
  )

  // Update FAQ
  .patch(
    "/:id",
    describeRoute({
      tags: ["FAQ"],
      summary: "Update FAQ entry",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(FaqEntrySchema, "Updated FAQ entry"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    v("param", z.object({ id: z.uuid() })),
    v("json", UpdateFaqSchema, (c) => ({ code: "BAD_INPUT", message: faqServiceMessages(getLocale(c)).invalidRequest })),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      return respond(c, faqService.entry.update({ id, data: input, locale: getLocale(c) }));
    },
  )

  // Delete FAQ
  .delete(
    "/:id",
    describeRoute({
      tags: ["FAQ"],
      summary: "Delete FAQ entry",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "FAQ deleted"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    v("param", z.object({ id: z.uuid() })),
    async (c) => {
      const { id } = c.req.valid("param");
      const t = faqServiceMessages(getLocale(c));
      return respond(c, withMessage(faqService.entry.remove({ id, locale: getLocale(c) }), t.deleted));
    },
  )

  // Reorder FAQs
  .put(
    "/reorder",
    describeRoute({
      tags: ["FAQ"],
      summary: "Reorder FAQ entries",
      ...requiresAdmin,
      responses: {
        200: jsonResponse(MessageResponseSchema, "FAQs reordered"),
      },
    }),
    v("json", ReorderFaqSchema, (c) => ({ code: "BAD_INPUT", message: faqServiceMessages(getLocale(c)).invalidRequest })),
    async (c) => {
      const { ids } = c.req.valid("json");
      const t = faqServiceMessages(getLocale(c));
      return respond(c, withMessage(faqService.entry.reorder({ ids, locale: getLocale(c) }), t.reordered));
    },
  );

export default app;
export type ApiType = typeof app;
