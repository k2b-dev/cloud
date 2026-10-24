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
    ["/conversations/read-all", "post"],
    ["/conversations/{conversation}/read", "post"],
    ["/conversations/{conversation}/unread", "post"],
    ["/conversations", "post"],
    ["/conversations", "get"],
    ["/conversations/{conversation}", "get"],
    ["/conversations/{conversation}", "patch"],
    ["/conversations/{conversation}/members", "get"],
    ["/conversations/{conversation}/members", "post"],
    ["/conversations/{conversation}/members/preview", "post"],
    ["/conversations/{conversation}/members/{accessId}", "patch"],
    ["/conversations/{conversation}/members/{accessId}", "delete"],
    ["/conversations/{conversation}/leave", "post"],
    ["/conversations/{conversation}/messages", "post"],
    ["/conversations/{conversation}/messages", "get"],
    ["/conversations/{conversation}/messages/{message}", "get"],
    ["/conversations/{conversation}/changes", "get"],
    ["/conversations/{conversation}/snapshot", "get"],
    ["/conversations/{conversation}/threads", "get"],
    ["/conversations/{conversation}/threads", "post"],
    ["/conversations/{conversation}/threads/{thread}", "patch"],
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
  expect(response.content["application/json"].schema.required).toContain("read");
  expect(response.content["application/json"].schema.required).toContain("unread");
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
  expect(response.content["application/json"].schema.required).toEqual(["cursor", "conversation", "page", "threads", "focus"]);
});

test("member list documents name search and opaque keyset cursors", async () => {
  const spec = SpecSchema.parse(await generateSpecs(new Hono<AuthContext>().route("/api/chat", chatApi)));
  const parameters = z
    .array(z.object({ name: z.string(), in: z.string() }))
    .parse(spec.paths["/api/chat/conversations/{conversation}/members"]?.get?.parameters);
  expect(parameters).toContainEqual({ name: "q", in: "query" });
  expect(parameters).toContainEqual({ name: "cursor", in: "query" });
  const response = z
    .object({
      content: z.object({
        "application/json": z.object({
          schema: z.object({ required: z.array(z.string()), properties: z.record(z.string(), z.unknown()) }),
        }),
      }),
    })
    .parse(spec.paths["/api/chat/conversations/{conversation}/members"]?.get?.responses["200"]);
  expect(response.content["application/json"].schema.required).toEqual(["items", "nextCursor", "managers", "self"]);
  expect(response.content["application/json"].schema.properties.self).toMatchObject({
    anyOf: [
      {
        type: "object",
        required: ["accessId", "permission", "active"],
        properties: {
          accessId: { type: "string", format: "uuid" },
          permission: { type: "string", enum: ["read", "write", "admin"] },
          active: { type: "boolean" },
        },
      },
      { type: "null" },
    ],
  });
});

test("member removal and leave require the group access outcome", async () => {
  const spec = SpecSchema.parse(await generateSpecs(new Hono<AuthContext>().route("/api/chat", chatApi)));
  for (const [path, method] of [
    ["/api/chat/conversations/{conversation}/members/{accessId}", "delete"],
    ["/api/chat/conversations/{conversation}/leave", "post"],
  ] as const) {
    const response = z
      .object({
        content: z.object({
          "application/json": z.object({
            schema: z.object({ required: z.array(z.string()), properties: z.record(z.string(), z.unknown()) }),
          }),
        }),
      })
      .parse(spec.paths[path]?.[method]?.responses["200"]);
    expect(response.content["application/json"].schema.required).toEqual(["success", "keptThroughGroup"]);
    expect(response.content["application/json"].schema.properties.keptThroughGroup).toMatchObject({ type: "boolean" });
  }
});

test("documents optional create identity and payload conflicts", async () => {
  const spec = SpecSchema.parse(await generateSpecs(new Hono<AuthContext>().route("/api/chat", chatApi)));
  const create = spec.paths["/api/chat/conversations"]!.post!;
  expect(create.responses["409"]).toBeDefined();
  const body = z
    .object({
      content: z.object({
        "application/json": z.object({
          schema: z.object({
            properties: z.record(z.string(), z.unknown()),
            required: z.array(z.string()).optional(),
          }),
        }),
      }),
    })
    .parse(create.requestBody);
  expect(body.content["application/json"].schema.properties.createKey).toBeDefined();
  expect(body.content["application/json"].schema.required ?? []).not.toContain("createKey");
});

test("thread operations document conflicts and filtered history and read selectors", async () => {
  const spec = SpecSchema.parse(await generateSpecs(new Hono<AuthContext>().route("/api/chat", chatApi)));
  const create = spec.paths["/api/chat/conversations/{conversation}/threads"]!.post!;
  for (const status of ["200", "201", "403", "409"]) expect(create.responses[status]).toBeDefined();
  const update = spec.paths["/api/chat/conversations/{conversation}/threads/{thread}"]!.patch!;
  for (const status of ["200", "403", "404", "409"]) expect(update.responses[status]).toBeDefined();
  for (const path of ["messages", "snapshot"]) {
    const parameters = z
      .array(z.object({ name: z.string(), in: z.string() }))
      .parse(spec.paths[`/api/chat/conversations/{conversation}/${path}`]!.get!.parameters);
    expect(parameters).toContainEqual({ name: "thread", in: "query" });
  }
});
