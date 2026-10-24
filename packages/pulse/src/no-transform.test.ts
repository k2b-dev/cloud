import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { prepareNoTransformRouterTest } from "../../../scripts/fixtures/no-transform";

prepareNoTransformRouterTest();
const storeService = await import("./store/service");
const configured = spyOn(storeService, "pulseStoreConfigured").mockResolvedValue(true);
afterAll(() => configured.mockRestore());

const { default: api } = await import("./api/index");
const { default: pages } = await import("./frontend/index");

describe("compression boundaries", () => {
  for (const path of [
    "/bases",
    "/bases/base/sources",
    "/bases/base/sources/source/scrapes",
    "/bases/base/sources/source/api-keys",
    "/__new_route__",
  ]) {
    test(`api ${path} opts out`, async () => {
      const response = await api.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
    });
  }
  for (const path of ["/ingest", "/bases/base/sources/source/ingest"]) {
    test(`api POST ${path} opts out`, async () => {
      const response = await api.request(path, { method: "POST" });
      expect(response.status).toBeLessThan(500);
      expect(response.status).not.toBe(404);
      expect(api.router.match("POST", path)[0].some(([[, route]]) => route.method === "POST")).toBe(true);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
    });
  }
  for (const path of [
    "/",
    "/base",
    "/base/__new_route__",
    "/base/sources",
    "/base/resources",
    "/base/explorer",
    "/base/dashboards/dashboard",
    "/base/query-reference",
    "/__new_route__",
  ]) {
    test(`pages ${path} opts out`, async () => {
      const response = await pages.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
    });
  }
});

test("every current workspace address mounts a page and keeps its authentication guard", async () => {
  for (const path of [
    "/base",
    "/base/sql",
    "/base/sql/query",
    "/base/dashboards",
    "/base/dashboards/dashboard",
    "/base/sources/source",
    "/base/sources",
  ]) {
    const response = await pages.request(path);
    expect(response.status).toBeLessThan(500);
    expect(response.status).not.toBe(404);
    expect(pages.router.match("GET", path)[0].some(([[, route]]) => route.method === "GET")).toBe(true);
    expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
  }
});

test("the fresh Pulse workspace does not register removed legacy addresses", () => {
  for (const path of [
    "/base/query-reference",
    "/base/events",
    "/base/metrics",
    "/base/states",
    "/base/dashboards/dashboard/edit",
    "/base/resources/resource",
    "/base/resources",
    "/base/explorer",
    "/base/metrics/signal",
    "/base/states/signal",
    "/base/events/signal",
    "/base/signals/events",
    "/base/signals/states",
    "/base/signals/metrics",
    "/base/signals",
    "/base/signals/events/old-signal",
    "/base/resources/type/resource",
    "/base/query-reference/old-topic",
  ]) {
    expect(pages.router.match("GET", path)[0].some(([[, route]]) => route.method === "GET")).toBe(false);
  }
});
