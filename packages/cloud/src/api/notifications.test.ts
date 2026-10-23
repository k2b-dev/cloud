import { expect, test } from "bun:test";
import { Hono } from "hono";
import { generateSpecs } from "hono-openapi";
import { notificationRoutes } from "./notifications";

test("the mounted inbox publishes bearer auth, max100 pagination and its readable response in OpenAPI", async () => {
  const spec = await generateSpecs(new Hono().route("/api/notifications", notificationRoutes));
  const operation = spec.paths["/api/notifications/inbox"]?.get;
  expect(operation).toBeDefined();
  expect(operation?.security).toEqual([{ bearerAuth: [] }]);
  expect(operation?.parameters).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "perPage", in: "query", schema: expect.objectContaining({ maximum: 100, default: 20 }) }),
    ]),
  );
  expect(operation?.responses).toHaveProperty("200");
  expect(operation?.responses).toHaveProperty("401");
  expect(operation?.responses).toHaveProperty("403");
  expect(JSON.stringify(operation?.responses?.["200"])).toContain('"body"');
  expect(JSON.stringify(operation?.responses?.["200"])).not.toContain("payload_encrypted");
});
