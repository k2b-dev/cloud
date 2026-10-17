import { expect, test } from "bun:test";
import { generateSpecs } from "hono-openapi";
import { z } from "zod";
import spacesApi from ".";

const OperationSchema = z.object({
  summary: z.string(),
  responses: z.record(z.string(), z.unknown()),
  parameters: z.array(z.object({ name: z.string(), in: z.string() })).optional(),
});

test("publishes both reaction intents with typed summaries and stable error responses", async () => {
  const spec = z.object({ paths: z.record(z.string(), z.record(z.string(), OperationSchema)) }).parse(await generateSpecs(spacesApi));
  const path = spec.paths["/{id}/items/{itemId}/reactions/{emoji}"];
  for (const method of ["put", "delete"]) {
    const operation = path?.[method];
    expect(operation?.summary).toBe(method === "put" ? "Add reaction" : "Remove reaction");
    for (const status of ["200", "400", "403", "404", ...(method === "put" ? ["409"] : [])])
      expect(operation?.responses[status]).toBeDefined();
    expect(
      operation?.parameters
        ?.filter((p) => p.in === "path")
        .map((p) => p.name)
        .sort(),
    ).toEqual(["emoji", "id", "itemId"]);
    expect(operation?.parameters?.some((p) => p.name === "recurrence_id")).toBe(false);
  }
});
