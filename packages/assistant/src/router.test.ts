import { describe, expect, test } from "bun:test";
import { prepareNoTransformRouterTest } from "../../../scripts/fixtures/no-transform";
import { app } from "./config";

prepareNoTransformRouterTest();
const { router } = await import("./router");

describe("compression boundary", () => {
  for (const prefix of app.meta.routes) {
    for (const path of [prefix, `${prefix}/__compression_guard__`]) {
      test(`${path} opts out before any route can answer`, async () => {
        const response = await router.request(path);
        expect(response.status).toBeLessThan(500);
        expect(response.headers.get("Cache-Control")).toMatch(/(?:^|,)\s*no-transform(?:\s*,|$)/i);
      });
    }
  }
});
