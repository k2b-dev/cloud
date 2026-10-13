import { expect, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { generateSpecs } from "hono-openapi";
import { z } from "zod";
import chatApi from ".";

const OperationSchema = z.object({
  summary: z.string(),
  responses: z.record(z.string(), z.unknown()),
  requestBody: z.unknown().optional(),
  parameters: z.array(z.unknown()).optional(),
});
const SpecSchema = z.object({ paths: z.record(z.string(), z.record(z.string(), OperationSchema)) });
test("publishes every conversation operation with typed request and response schemas", async () => {
  const app = new Hono<AuthContext>().route("/api/chat", chatApi);
  const spec = SpecSchema.parse(await generateSpecs(app));
  for (const [path, method] of [
    ["/people", "get"],
    ["/conversations", "post"],
    ["/conversations", "get"],
    ["/conversations/{conversation}", "get"],
    ["/conversations/{conversation}", "patch"],
    ["/conversations/{conversation}/members", "get"],
    ["/conversations/{conversation}/members", "post"],
    ["/conversations/{conversation}/members/{accessId}", "patch"],
    ["/conversations/{conversation}/members/{accessId}", "delete"],
    ["/conversations/{conversation}/leave", "post"],
    ["/conversations/{conversation}/messages", "post"],
    ["/conversations/{conversation}/messages", "get"],
    ["/conversations/{conversation}/messages/{message}", "get"],
    ["/conversations/{conversation}/changes", "get"],
    ["/conversations/{conversation}/snapshot", "get"],
  ] as const) {
    const operation = spec.paths[`/api/chat${path}`]?.[method];
    expect(operation).toBeDefined();
    expect(operation?.responses[method === "post" && path === "/conversations" ? "201" : "200"]).toBeDefined();
    if (["post", "patch"].includes(method)) expect(operation?.requestBody).toBeDefined();
    if (path.includes("{conversation}")) expect(operation?.parameters?.length).toBeGreaterThanOrEqual(1);
  }
});

test("documents the request limiter's 429 body, which carries no code, on chat creation", async () => {
  const app = new Hono<AuthContext>().route("/api/chat", chatApi);
  const spec = await generateSpecs(app);
  const body = z
    .object({ content: z.object({ "application/json": z.object({ schema: z.object({ required: z.array(z.string()) }) }) }) })
    .parse(SpecSchema.parse(spec).paths["/api/chat/conversations"]?.post?.responses["429"]);
  expect(body.content["application/json"].schema.required).toEqual(["message"]);
});

test("documents message retry, creation, send limits and restore resync", async () => {
  const spec = SpecSchema.parse(await generateSpecs(new Hono<AuthContext>().route("/api/chat", chatApi)));
  const send = spec.paths["/api/chat/conversations/{conversation}/messages"]?.post;
  for (const status of ["200", "201", "429"]) expect(send?.responses[status]).toBeDefined();
  expect(spec.paths["/api/chat/conversations/{conversation}/changes"]?.get?.responses["409"]).toBeDefined();
});

test("conversation responses require the revision used to guard live summaries", async () => {
  const spec = SpecSchema.parse(await generateSpecs(new Hono<AuthContext>().route("/api/chat", chatApi)));
  const response = z
    .object({
      content: z.object({
        "application/json": z.object({
          schema: z.object({ required: z.array(z.string()), properties: z.record(z.string(), z.unknown()) }),
        }),
      }),
    })
    .parse(spec.paths["/api/chat/conversations/{conversation}"]?.get?.responses["200"]);
  expect(response.content["application/json"].schema.required).toContain("rev");
  expect(response.content["application/json"].schema.properties.rev).toBeDefined();
});

test("snapshot documents its canonical response and hidden-chat 404", async () => {
  const spec = SpecSchema.parse(await generateSpecs(new Hono<AuthContext>().route("/api/chat", chatApi)));
  const operation = spec.paths["/api/chat/conversations/{conversation}/snapshot"]?.get;
  expect(operation?.summary).toBe("Open a chat: details, a page of history, and the live cursor");
  expect(operation?.responses["404"]).toBeDefined();
  const response = z
    .object({ content: z.object({ "application/json": z.object({ schema: z.object({ required: z.array(z.string()) }) }) }) })
    .parse(operation?.responses["200"]);
  expect(response.content["application/json"].schema.required).toEqual(["cursor", "conversation", "page", "focus"]);
});
