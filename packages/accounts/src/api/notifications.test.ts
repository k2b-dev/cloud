import { expect, test } from "bun:test";
import { generateSpecs } from "hono-openapi";
import notifications from "./notifications";

test("batch recipient OpenAPI describes outgoing mail identity and current status", async () => {
  const spec = await generateSpecs(notifications);
  const response = spec.paths?.["/batches/{id}/recipients"]?.get?.responses?.["200"];
  const schema = response && "$ref" in response ? undefined : response?.content?.["application/json"]?.schema;
  expect(schema).toMatchObject({
    properties: {
      recipients: {
        items: {
          properties: {
            outgoingMailId: { type: ["string", "null"] },
            outgoingMailStatus: {
              anyOf: [{ type: "string", enum: ["queued", "sending", "sent", "failed", "bounced", "cancelled"] }, { type: "null" }],
            },
          },
        },
      },
    },
  });
});
