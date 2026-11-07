import { describe, expect, test } from "bun:test";
import { prepareNoTransformRouterTest } from "../../../scripts/fixtures/no-transform";
import { app } from "./config";

prepareNoTransformRouterTest();
const { apiRoutes, router } = await import("./router");

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

test("the API schema tree and mounted machine operations use the same declared prefix", () => {
  const routes = [
    ["POST", "/artifacts/machine/:id/execute"],
    ["GET", "/artifacts/machine/:id/source"],
    ["PUT", "/artifacts/machine/:id/storage/file"],
    ["POST", "/artifacts/machine/:id/database"],
    ["PUT", "/artifacts/machine/:id/access/:accessId"],
  ];
  for (const [method, path] of routes) {
    expect(apiRoutes.routes.some((route) => route.method === method && route.path === path)).toBe(true);
    expect(router.routes.some((route) => route.method === method && route.path === `/api/assistant${path}`)).toBe(true);
  }
});
