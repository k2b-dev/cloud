import { type AuthContext, getLocale, jsonResponse, middleware, requiresAuth } from "@k2b/cloud/server";
import type { Result } from "@k2b/stdlib";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import {
  AnnotationCreateSchema,
  AnnotationDataSchema,
  AnnotationEditSchema,
  AnnotationOperationSchema,
  AnnotationPageSchema,
  AnnotationProjectionSchema,
  AnnotationReplyDataSchema,
  AnnotationReplySchema,
} from "../lib/annotation-contracts";
import * as annotations from "../service/annotations";
import { notebookV as v } from "./validator";

const context = (c: Context<AuthContext>): annotations.AnnotationContext => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  locale: getLocale(c),
  requestId: c.req.raw.headers.get("x-request-id")?.slice(0, 200) ?? crypto.randomUUID(),
  signal: c.req.raw.signal,
});
// The generic response helper omits service-error details. These routes retain
// conflict text and the durable operation ID so a client can recover.
const respond = async <T>(c: Context<AuthContext>, resultPromise: Promise<Result<T>> | Result<T>) => {
  const result = await resultPromise;
  if (!result.ok)
    return c.json(
      { message: result.error.message, code: result.error.code, ...("details" in result.error ? { details: result.error.details } : {}) },
      result.error.status,
    );
  return c.json(result.data);
};
const MutationSchema = z.object({ id: z.uuid(), annotationId: z.uuid(), deleted: z.boolean() });
const OperationDataSchema = z.object({
  id: z.uuid(),
  operationId: z.uuid(),
  status: z.literal("applied"),
  state: z.enum(["open", "resolved", "accepted"]),
});
const ReplyPageSchema = z.object({ items: z.array(AnnotationReplyDataSchema), nextCursor: z.string().nullable() });
const route = (summary: string, schema: z.ZodType) =>
  describeRoute({
    tags: ["Notebooks"],
    summary,
    ...requiresAuth,
    responses: {
      200: jsonResponse(schema, summary),
      400: { description: "Invalid comment input" },
      403: { description: "Write access or author window required" },
      404: { description: "Note or comment not found" },
      409: { description: "Passage, idempotency or suggestion conflict; message and optional details.currentText/operationId" },
      500: { description: "Suggestion outcome pending; retry details.operationId" },
    },
  });

/** Mounted after normal API authentication and rate limits. */
export const annotationRoutes = new Hono<AuthContext>()
  .use("*", middleware.noTransform())
  // JSON escaping of the 5,000 body + two 2,000 passage/replacement fields
  // fits in 64 KiB; reject oversized payloads before parsing.
  .use("*", bodyLimit({ maxSize: 64 * 1024 }))
  .get(
    "/",
    route("List passage comments with one consistent Markdown snapshot", AnnotationProjectionSchema),
    v("query", AnnotationPageSchema),
    (c) => respond(c, annotations.list(c.req.param("noteId")!, c.req.valid("query"), context(c))),
  )
  .post("/", route("Comment on a passage", AnnotationDataSchema), v("json", AnnotationCreateSchema), (c) =>
    respond(c, annotations.create(c.req.param("noteId")!, c.req.valid("json"), context(c))),
  )
  .get("/:annotationId", route("Read a passage comment", AnnotationDataSchema), (c) =>
    respond(c, annotations.read(c.req.param("noteId")!, c.req.param("annotationId")!, context(c))),
  )
  .patch("/:annotationId", route("Edit your recent passage comment", MutationSchema), v("json", AnnotationEditSchema), (c) =>
    respond(
      c,
      annotations.mutate(c.req.param("noteId")!, c.req.param("annotationId")!, { kind: "edit", ...c.req.valid("json") }, context(c)),
    ),
  )
  .delete("/:annotationId", route("Delete your recent passage comment without replies", MutationSchema), (c) =>
    respond(c, annotations.mutate(c.req.param("noteId")!, c.req.param("annotationId")!, { kind: "delete" }, context(c))),
  )
  .post("/:annotationId/restore", route("Restore your recent deleted passage comment", MutationSchema), (c) =>
    respond(c, annotations.mutate(c.req.param("noteId")!, c.req.param("annotationId")!, { kind: "restore" }, context(c))),
  )
  .post(
    "/:annotationId/resolve",
    route("Resolve or reopen a passage comment", MutationSchema),
    v("json", z.object({ resolved: z.boolean() }).strict()),
    (c) =>
      respond(
        c,
        annotations.mutate(
          c.req.param("noteId")!,
          c.req.param("annotationId")!,
          { kind: c.req.valid("json").resolved ? "resolve" : "reopen" },
          context(c),
        ),
      ),
  )
  .post(
    "/:annotationId/accept",
    route("Accept a suggestion with a retryable operation ID", OperationDataSchema),
    v("json", AnnotationOperationSchema),
    (c) => respond(c, annotations.operate(c.req.param("noteId")!, c.req.param("annotationId")!, "accept", c.req.valid("json"), context(c))),
  )
  .post(
    "/:annotationId/undo-accept",
    route("Undo an accepted suggestion if its inserted text is unchanged", OperationDataSchema),
    v("json", AnnotationOperationSchema),
    (c) => respond(c, annotations.operate(c.req.param("noteId")!, c.req.param("annotationId")!, "undo", c.req.valid("json"), context(c))),
  )
  .get(
    "/:annotationId/replies",
    route("Read further replies to a passage comment", ReplyPageSchema),
    v("query", AnnotationPageSchema),
    (c) => respond(c, annotations.replies(c.req.param("noteId")!, c.req.param("annotationId")!, c.req.valid("query"), context(c))),
  )
  .post("/:annotationId/replies", route("Reply to a passage comment", AnnotationReplyDataSchema), v("json", AnnotationReplySchema), (c) =>
    respond(c, annotations.reply(c.req.param("noteId")!, c.req.param("annotationId")!, c.req.valid("json"), context(c))),
  )
  .patch(
    "/:annotationId/replies/:replyId",
    route("Edit your recent reply", MutationSchema),
    v("json", z.object({ body: z.string().trim().min(1).max(5_000) }).strict()),
    (c) =>
      respond(
        c,
        annotations.mutate(
          c.req.param("noteId")!,
          c.req.param("annotationId")!,
          { kind: "edit", replyId: c.req.param("replyId"), ...c.req.valid("json") },
          context(c),
        ),
      ),
  )
  .delete("/:annotationId/replies/:replyId", route("Delete your recent reply", MutationSchema), (c) =>
    respond(
      c,
      annotations.mutate(
        c.req.param("noteId")!,
        c.req.param("annotationId")!,
        { kind: "delete", replyId: c.req.param("replyId") },
        context(c),
      ),
    ),
  )
  .post("/:annotationId/replies/:replyId/restore", route("Restore your recent deleted reply", MutationSchema), (c) =>
    respond(
      c,
      annotations.mutate(
        c.req.param("noteId")!,
        c.req.param("annotationId")!,
        { kind: "restore", replyId: c.req.param("replyId") },
        context(c),
      ),
    ),
  );
