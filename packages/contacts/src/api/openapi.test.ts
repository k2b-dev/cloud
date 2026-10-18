import { expect, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { generateSpecs } from "hono-openapi";
import { z } from "zod";
import contactsApi from ".";

const OperationSchema = z.object({
  security: z.array(z.record(z.string(), z.array(z.string()))).optional(),
  responses: z.record(z.string(), z.object({ description: z.string().optional(), content: z.unknown().optional() })),
});
const SpecSchema = z.object({ paths: z.record(z.string(), z.record(z.string(), OperationSchema)) });
const errorResponseSchema = z.object({
  content: z.object({
    "application/json": z.object({
      schema: z.object({
        required: z.array(z.string()),
        properties: z.object({ message: z.object({ type: z.literal("string") }), code: z.object({ type: z.literal("string") }) }),
      }),
    }),
  }),
});

const generateSpec = async () => SpecSchema.parse(await generateSpecs(new Hono<AuthContext>().route("/api/contacts", contactsApi)));

test("every secured Contacts operation documents the authentication error body", async () => {
  const spec = await generateSpec();
  let securedOperations = 0;
  let securedBookOperations = 0;
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!operation.security?.some((requirement) => Object.keys(requirement).length > 0)) continue;
      securedOperations++;
      expect(operation.responses["401"], `${method} ${path}`).toBeDefined();
      const response = errorResponseSchema.parse(operation.responses["401"]);
      expect(response.content["application/json"].schema.required).toEqual(["message"]);
      if (!path.includes("{bookId}")) continue;
      securedBookOperations++;
      for (const status of ["403", "404"]) expect(operation.responses[status], `${method} ${path}`).toBeDefined();
    }
  }
  expect(securedOperations).toBeGreaterThan(0);
  expect(securedBookOperations).toBeGreaterThan(0);
});

test("exports, tags, and import commit document reachable authentication and book access errors (#1239)", async () => {
  const spec = await generateSpec();
  for (const [path, method] of [
    ["/books/{bookId}/export.vcf", "get"],
    ["/books/{bookId}/export.csv", "get"],
    ["/books/{bookId}/tags", "get"],
    ["/books/{bookId}/import/commit", "post"],
  ] as const) {
    const operation = spec.paths[`/api/contacts${path}`]?.[method];
    for (const status of ["401", "403", "404"]) expect(operation?.responses[status], `${method} ${path}`).toBeDefined();
  }
});

test("route-specific access errors survive shared response metadata", async () => {
  const spec = await generateSpec();
  const operation = spec.paths["/api/contacts/books/{bookId}/access/{accessId}"]?.patch;
  expect(operation?.responses["409"]?.description).toBe("The change would leave the book without a manager (LAST_MANAGER)");
  expect(operation?.responses["404"]?.description).toBe("Book or access entry not found");
});
