import { describe, expect, test } from "bun:test";
import { prepareNoTransformRouterTest } from "../../../scripts/fixtures/no-transform";

prepareNoTransformRouterTest();

const { default: api } = await import("./api/index");
const { default: pages } = await import("./frontend/index");

describe("compression boundaries", () => {
  for (const path of [
    "/account-requests",
    "/account-requests/request",
    "/notifications/batches",
    "/notifications/batches/batch/recipients",
    "/notifications/__new_route__",
  ]) {
    test(`api ${path} opts out`, async () => {
      const response = await api.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
    });
  }
  for (const path of ["/users", "/groups", "/audit", "/service-accounts"]) {
    test(`api ${path} stays eligible for compression`, async () => {
      const response = await api.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-transform");
    });
  }
  for (const path of ["/requests", "/notifications", "/notifications/batch"]) {
    test(`pages ${path} opts out`, async () => {
      const response = await pages.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
    });
  }
  for (const path of ["/", "/users", "/groups", "/audit"]) {
    test(`pages ${path} stays eligible for compression`, async () => {
      const response = await pages.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-transform");
    });
  }
});
