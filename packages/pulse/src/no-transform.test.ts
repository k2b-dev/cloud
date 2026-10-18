import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { prepareNoTransformRouterTest } from "../../../scripts/fixtures/no-transform";

prepareNoTransformRouterTest();

const { pulseService } = await import("./service");
const missing = spyOn(pulseService.dashboard, "publicSnapshot").mockResolvedValue({
  ok: false,
  error: { code: "NOT_FOUND", message: "Missing dashboard", status: 404 },
});
afterAll(() => missing.mockRestore());

const { default: api } = await import("./api/index");
const { default: pages } = await import("./frontend/index");

describe("compression boundaries", () => {
  for (const path of [
    "/bases",
    "/query/metric-text",
    "/query/metric-text/__new_route__",
    "/bases/base/inventory",
    "/bases/base/inventory/__new_route__",
    "/bases/base/resource-events",
    "/bases/base/resource-events/__new_route__",
    "/bases/base/resource-states",
    "/bases/base/resource-states/__new_route__",
    "/bases/base/recent-events",
    "/bases/base/recent-events/__new_route__",
    "/bases/base/states",
    "/bases/base/states/__new_route__",
    "/dashboards/dashboard/snapshot",
    "/dashboards/dashboard/snapshot/__new_route__",
    "/public-dashboard/token",
    "/public-dashboard/token/__new_route__",
    "/bases/base/metrics",
    "/bases/base/series",
    "/bases/base/resources",
    "/bases/base/resource-metrics",
    "/bases/base/sources",
    "/__new_route__",
  ]) {
    test(`api ${path} opts out`, async () => {
      const response = await api.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
    });
  }
  for (const path of ["/query/metric", "/query/event-map", "/query/compile-text"]) {
    test(`api POST ${path} opts out`, async () => {
      const response = await api.request(path, { method: "POST" });
      expect(response.status).toBeLessThan(500);
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
    "/display/token",
    "/display/token/__new_route__",
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

test("every existing workspace address still reaches its authentication guard", async () => {
  for (const path of [
    "/base",
    "/base/dashboards/dashboard/edit",
    "/base/dashboards/dashboard",
    "/base/sources/source",
    "/base/sources",
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
  ]) {
    const response = await pages.request(path);
    expect(response.status).toBeLessThan(500);
    expect(response.status).not.toBe(404);
    expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
  }
});

for (const path of ["/query/event-map", "/query/event-map/__new_route__"]) {
  test(`POST ${path} opts out`, async () => {
    const response = await api.request(path, { method: "POST" });
    expect(response.status).toBeLessThan(500);
    expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
  });
}
