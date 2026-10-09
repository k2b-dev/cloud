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
    ["/conversations", "post"],
    ["/conversations", "get"],
    ["/conversations/{conversation}", "get"],
    ["/conversations/{conversation}", "patch"],
    ["/conversations/{conversation}/members", "get"],
    ["/conversations/{conversation}/members", "post"],
    ["/conversations/{conversation}/members/{accessId}", "patch"],
    ["/conversations/{conversation}/members/{accessId}", "delete"],
    ["/conversations/{conversation}/leave", "post"],
  ] as const) {
    const operation = spec.paths[`/api/chat${path}`]?.[method];
    expect(operation).toBeDefined();
    expect(operation?.responses[method === "post" && path === "/conversations" ? "201" : "200"]).toBeDefined();
    if (["post", "patch"].includes(method)) expect(operation?.requestBody).toBeDefined();
    if (path.includes("{conversation}")) expect(operation?.parameters?.length).toBeGreaterThanOrEqual(1);
  }
});
