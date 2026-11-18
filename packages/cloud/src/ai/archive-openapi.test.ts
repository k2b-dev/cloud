import { expect, test } from "bun:test";
import { generateSpecs } from "hono-openapi";
import { aiRoutes } from "./routes";

test("archive OpenAPI describes the existing success body with the count of discarded messages", async () => {
  const spec = await generateSpecs(aiRoutes);
  const operation = spec.paths?.["/conversations/{conversationId}/archive"]?.post;
  expect(operation?.security).toBeDefined();
  expect(operation?.responses?.["200"]).toMatchObject({
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["ok", "discardedQueuedMessages"],
          properties: { ok: { const: true }, discardedQueuedMessages: { type: "integer", minimum: 0 } },
        },
      },
    },
  });
  expect(operation?.responses?.["409"]).toBeDefined();
});
