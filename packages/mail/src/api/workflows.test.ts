import { describe, expect, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { generateSpecs } from "hono-openapi";
import workflowRoutes from "./workflows";

const app = () => new Hono<AuthContext>().route("/", workflowRoutes);

const expectedOperations = [
  ["post", "/mailboxes/{mailboxId}/workflows/autocomplete", "Complete Mail workflow YAML", ["200", "400", "401", "403"]],
  ["post", "/mailboxes/{mailboxId}/workflows/validate", "Validate Mail workflow YAML", ["200", "400", "401", "403"]],
  ["get", "/mailboxes/{mailboxId}/workflows", "List Mail workflows", ["200", "400", "401", "403"]],
  ["post", "/mailboxes/{mailboxId}/workflows", "Create a Mail workflow", ["200", "400", "401", "403", "409", "500"]],
  ["get", "/mailboxes/{mailboxId}/workflows/{workflowId}", "Get a Mail workflow", ["200", "400", "401", "403", "404"]],
  [
    "patch",
    "/mailboxes/{mailboxId}/workflows/{workflowId}",
    "Update Mail workflow metadata",
    ["200", "400", "401", "403", "404", "409", "500"],
  ],
  ["get", "/mailboxes/{mailboxId}/workflows/{workflowId}/versions", "List Mail workflow versions", ["200", "400", "401", "403", "404"]],
  [
    "post",
    "/mailboxes/{mailboxId}/workflows/{workflowId}/versions",
    "Create a Mail workflow version",
    ["200", "400", "401", "403", "404", "500"],
  ],
  [
    "get",
    "/mailboxes/{mailboxId}/workflows/{workflowId}/versions/{versionId}",
    "Get a Mail workflow version",
    ["200", "400", "401", "403", "404"],
  ],
  [
    "post",
    "/mailboxes/{mailboxId}/workflows/{workflowId}/versions/{versionId}/restore",
    "Restore a Mail workflow version",
    ["200", "400", "401", "403", "404", "409", "500"],
  ],
  [
    "post",
    "/mailboxes/{mailboxId}/workflows/{workflowId}/activate",
    "Activate a Mail workflow version",
    ["200", "400", "401", "403", "404", "409", "500"],
  ],
  [
    "post",
    "/mailboxes/{mailboxId}/workflows/{workflowId}/deactivate",
    "Deactivate a Mail workflow",
    ["200", "400", "401", "403", "404", "409", "500"],
  ],
] as const;

describe("Mail workflow OpenAPI contracts", () => {
  test("publishes every operation with stable metadata, authentication, and response schemas", async () => {
    const spec = await generateSpecs(app());

    for (const [method, path, summary, statuses] of expectedOperations) {
      const operation = spec.paths?.[path]?.[method];
      const expectedStatuses = [...new Set([...statuses, "500"])].sort((left, right) => Number(left) - Number(right));
      expect(operation?.tags).toEqual(["Mail:Workflows"]);
      expect(operation?.summary).toBe(summary);
      expect(operation?.security).toEqual([{ cookieAuth: [], bearerAuth: [] }]);
      expect(Object.keys(operation?.responses ?? {})).toEqual(expectedStatuses);

      for (const status of expectedStatuses) {
        const response = operation?.responses?.[status];
        expect(response && "$ref" in response ? undefined : response?.content?.["application/json"]?.schema).toBeDefined();
      }
    }
  });

  test("does not publish dangling component references", async () => {
    const spec = await generateSpecs(app());
    const references = JSON.stringify(spec).match(/#\/components\/schemas\/[A-Za-z0-9_-]+/g) ?? [];
    const schemas = spec.components?.schemas ?? {};

    expect(references.filter((reference) => !(reference.slice("#/components/schemas/".length) in schemas))).toEqual([]);
  });

  test("does not publish the removed Mail-owned run API", async () => {
    const spec = await generateSpecs(app());
    expect(Object.keys(spec.paths ?? {}).filter((path) => path.includes("workflow-runs"))).toEqual([]);
    expect(spec.paths?.["/mailboxes/{mailboxId}/workflows/{workflowId}/preflight"]).toBeUndefined();
  });
});
