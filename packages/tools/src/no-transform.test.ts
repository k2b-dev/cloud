import { describe, expect, test } from "bun:test";
import { prepareNoTransformRouterTest } from "../../../scripts/fixtures/no-transform";

prepareNoTransformRouterTest();

const { createToolsApiRouter } = await import("./api/index");
const { default: webhooks } = await import("./api/webhooks");

describe("compression boundaries", () => {
  for (const path of ["/endpoints", "/incoming-logs", "/outgoing-logs", "/send"]) {
    test(`api/webhooks (default) ${path} opts out`, async () => {
      const response = await webhooks.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control")).toMatch(/(?:^|,)\s*no-transform(?:\s*,|$)/i);
    });
  }
});

test("speed-test JSON stays eligible for compression beside webhooks", async () => {
  const response = await createToolsApiRouter().request("/speedtest/upload", { method: "POST" });
  expect(response.status).toBeLessThan(500);
  expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-transform");
});
