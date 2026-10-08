import { expect, test } from "bun:test";
import { stripImageMetadata } from "@k2b/cloud/services/image-metadata";
import { codeToolRoutes } from "./code-tool-routes";

test("code tool onError preserves malformed-image status and code", async () => {
  codeToolRoutes.post("/test-image-error", async (c) => {
    stripImageMetadata(new Uint8Array(await c.req.arrayBuffer()));
    return c.json({ ok: true });
  });
  const response = await codeToolRoutes.request("/test-image-error", { method: "POST", body: new Uint8Array([255, 216, 255, 219, 0]) });
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ ok: false, error: { code: "MALFORMED_IMAGE", message: "Malformed JPEG image." } });
});
