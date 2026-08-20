import { describe, expect, test } from "bun:test";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { generateSpecs } from "hono-openapi";
import basesRoutes from "./bases";
import fieldsRoutes from "./fields";
import { publicFormRoutes } from "./form-public-routes";
import recordsRoutes from "./records";
import tablesRoutes from "./tables";
import viewsRoutes from "./views";

const app = () =>
  new Hono<AuthContext>()
    .route("/bases", basesRoutes)
    .route("/fields", fieldsRoutes)
    .route("/forms", publicFormRoutes)
    .route("/records", recordsRoutes)
    .route("/tables", tablesRoutes)
    .route("/views", viewsRoutes);

describe("core resource OpenAPI contracts", () => {
  test("publishes validation, permission, absence, and conflict responses", async () => {
    const spec = await generateSpecs(app());
    const paths = spec.paths as Record<string, Record<string, { responses?: Record<string, unknown> } | undefined> | undefined>;
    const contracts = [
      ["get", "/bases", ["200", "400", "403"]],
      ["post", "/bases", ["201", "400", "403"]],
      ["get", "/bases/{baseId}", ["200", "403", "404"]],
      ["patch", "/bases/{baseId}", ["200", "400", "403", "404"]],
      ["delete", "/bases/{baseId}", ["204", "403", "404"]],
      ["post", "/bases/{baseId}/restore", ["200", "403", "404"]],
      ["get", "/bases/{baseId}/trash", ["200", "403", "404"]],
      ["get", "/fields/by-table/{tableId}", ["200", "403", "404"]],
      ["post", "/fields/by-table/{tableId}/reorder", ["204", "400", "403", "404"]],
      ["post", "/fields/by-table/{tableId}", ["201", "400", "403", "404", "409"]],
      ["get", "/fields/{fieldId}/dependents", ["200", "403", "404"]],
      ["patch", "/fields/{fieldId}", ["200", "400", "403", "404", "409"]],
      ["delete", "/fields/{fieldId}", ["204", "403", "404", "409"]],
      ["post", "/fields/{fieldId}/restore", ["200", "400", "403", "404", "409"]],
      ["post", "/forms/public/{token}/submit", ["201", "400", "403", "404"]],
      ["get", "/records/{tableId}/{recordId}/files/{fieldId}", ["200", "400", "403", "404", "409"]],
      ["post", "/records/{tableId}/{recordId}/files/{fieldId}", ["200", "400", "403", "404", "409", "413"]],
      ["put", "/records/{tableId}/{recordId}/files/{fieldId}/{fileId}", ["200", "400", "403", "404", "409", "413"]],
      ["get", "/records/{tableId}/{recordId}/files/{fieldId}/{fileId}/content", ["200", "400", "403", "404", "409"]],
      ["delete", "/records/{tableId}/{recordId}/files/{fieldId}/{fileId}", ["204", "403", "404", "409"]],
      ["get", "/records/{tableId}/{recordId}/referenced-by", ["200", "400", "403", "404"]],
      ["get", "/records/{tableId}/{recordId}/versions", ["200", "400", "403", "404"]],
      ["get", "/records/{tableId}/{recordId}/versions/{revisionId}/files/{fileId}", ["200", "403", "404"]],
      ["get", "/records/{tableId}/{recordId}/finalization", ["200", "403", "404"]],
      ["post", "/records/{tableId}/{recordId}/finalize", ["200", "400", "403", "404", "409"]],
      ["post", "/records/{tableId}/{recordId}/finalization/request", ["200", "400", "403", "404", "409"]],
      ["post", "/records/{tableId}/{recordId}/finalization/approve", ["200", "400", "403", "404", "409"]],
      ["post", "/records/{tableId}/{recordId}/finalization/reject", ["200", "400", "403", "404", "409"]],
      ["post", "/records/by-table/{tableId}", ["201", "400", "403", "404", "409"]],
      ["post", "/records/by-table/{tableId}/import", ["201", "400", "403", "404", "409"]],
      ["get", "/records/{tableId}/{recordId}", ["200", "400", "403", "404"]],
      ["patch", "/records/{tableId}/{recordId}", ["200", "400", "403", "404", "409"]],
      ["post", "/records/{tableId}/{recordId}/trash", ["204", "400", "403", "404", "409"]],
      ["post", "/records/by-table/{tableId}/export", ["200", "400", "403", "404", "409"]],
      ["get", "/records/by-table/{tableId}/audit", ["200", "400", "403", "404", "409"]],
      ["post", "/records/{tableId}/{recordId}/restore", ["204", "400", "403", "404", "409"]],
      ["get", "/records/{tableId}/{recordId}/audit", ["200", "403", "404"]],
      ["get", "/tables/by-base/{baseId}", ["200", "403", "404"]],
      ["get", "/tables/by-base/{baseId}/admin-overview", ["200", "403", "404"]],
      ["post", "/tables/by-base/{baseId}", ["201", "400", "403", "404", "409"]],
      ["get", "/tables/{tableId}/durable-history", ["200", "400", "403", "404"]],
      ["post", "/tables/{tableId}/durable-history/enable", ["200", "400", "403", "404"]],
      ["post", "/tables/{tableId}/durable-history/continue", ["200", "400", "403", "404"]],
      ["get", "/tables/{tableId}/finalization", ["200", "400", "403", "404"]],
      ["post", "/tables/{tableId}/finalization/enable", ["200", "400", "403", "404", "409"]],
      ["post", "/tables/{tableId}/finalization/disable", ["200", "403", "404", "409"]],
      ["put", "/tables/{tableId}/finalization/policy", ["200", "400", "403", "404"]],
      ["post", "/tables/{tableId}/mutation-policy/impact", ["200", "400", "403", "404"]],
      ["put", "/tables/{tableId}/mutation-policy", ["200", "400", "403", "404"]],
      ["get", "/tables/{tableId}", ["200", "403", "404"]],
      ["patch", "/tables/{tableId}", ["200", "400", "403", "404", "409"]],
      ["delete", "/tables/{tableId}", ["204", "403", "404"]],
      ["post", "/tables/{tableId}/restore", ["200", "403", "404", "409"]],
      ["post", "/tables/{tableId}/query", ["200", "400", "403", "404", "409", "503"]],
      ["get", "/views/by-table/{tableId}", ["200", "403", "404"]],
      ["post", "/views/by-table/{tableId}", ["201", "400", "403", "404", "409"]],
      ["patch", "/views/{viewId}", ["200", "400", "403", "404", "409"]],
      ["delete", "/views/{viewId}", ["204", "403", "404"]],
      ["post", "/views/{viewId}/restore", ["200", "403", "404", "409"]],
    ] as const;

    for (const [method, path, expected] of contracts) {
      expect(Object.keys(paths[path]?.[method]?.responses ?? {}).sort(), `${method.toUpperCase()} ${path}`).toEqual([...expected].sort());
    }
  });
});
