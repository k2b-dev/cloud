import { expect, test } from "bun:test";
import { notebooksCapabilities } from "../capabilities";
import { AnnotationAcceptSchema, AnnotationCreateSchema, AnnotationListSchema, AnnotationReplySchema } from "./annotation-contracts";

test("public annotation inputs preserve reply suggestions, deletion and bounded occurrence selectors", () => {
  const key = { idempotencyKey: "review" };
  expect(AnnotationReplySchema.parse({ ...key, suggestion: "" })).toEqual({ ...key, body: "", suggestion: "" });
  expect(AnnotationReplySchema.safeParse({ ...key, suggestion: "x".repeat(2001) }).success).toBeFalse();
  for (const occurrence of [0, -1, 1.5])
    expect(AnnotationCreateSchema.safeParse({ ...key, quote: "target", body: "Review", occurrence }).success).toBeFalse();
  expect(AnnotationListSchema.parse({})).toEqual({ state: "all", limit: 30 });
  expect(AnnotationListSchema.safeParse({ state: "rejected" }).success).toBeFalse();
  expect(AnnotationListSchema.safeParse({ author: "someone" }).success).toBeFalse();
  const replyId = "11111111-1111-4111-8111-111111111111";
  expect(AnnotationAcceptSchema.parse({ operationId: replyId, replyId })).toEqual({ operationId: replyId, replyId });
  for (const schema of [AnnotationCreateSchema, AnnotationReplySchema])
    expect(schema.safeParse({ ...key, quote: "target", body: "Review", via: "assistant" }).success).toBeFalse();
});

test("capabilities expose the same selectors, suggestion fields, and rejection contract", () => {
  const caps = notebooksCapabilities;
  const noteId = "note01";
  const id = "11111111-1111-4111-8111-111111111111";
  expect(caps.queries["annotation.list"].input.parse({ noteId, state: "open", author: "me" })).toMatchObject({
    state: "open",
    author: "me",
  });
  expect(caps.actions["annotation.create"].input.parse({ noteId, quote: "target", body: "Review", occurrence: 2 })).toHaveProperty(
    "occurrence",
    2,
  );
  expect(caps.actions["annotation.reply"].input.parse({ noteId, annotationId: id, suggestion: "" })).toHaveProperty("suggestion", "");
  expect(caps.actions["annotation.accept"].input.parse({ noteId, annotationId: id, operationId: id, replyId: id })).toHaveProperty(
    "replyId",
    id,
  );
  expect(caps.actions["annotation.reject"].input.parse({ noteId, annotationId: id })).toHaveProperty("rejected", true);
  expect(caps.actions["annotation.reply"].description).toContain("never accept your own suggestion");
});
