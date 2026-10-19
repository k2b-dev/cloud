import { describe, expect, test } from "bun:test";
import { prepareNoTransformRouterTest } from "../../../scripts/fixtures/no-transform";

prepareNoTransformRouterTest();

const { router } = await import("./router");
const { apiRoutes } = await import("./api");
const { default: logs } = await import("./observability/logs/api");
const { default: workflows } = await import("./observability/workflows/api");
const { default: capabilities } = await import("./observability/capabilities/api");
const { default: notifications } = await import("./observability/notifications/api");

const { default: jobs } = await import("./observability/jobs/api");
const { default: sync } = await import("./observability/sync/api");

describe("compression boundaries", () => {
  for (const path of ["/", "/__compression_guard__"]) {
    test(`observability/logs/api (default) ${path} opts out`, async () => {
      const response = await logs.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control")).toMatch(/(?:^|,)\s*no-transform(?:\s*,|$)/i);
    });
  }
  for (const path of ["/", "/__compression_guard__"]) {
    test(`observability/workflows/api (default) ${path} opts out`, async () => {
      const response = await workflows.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control")).toMatch(/(?:^|,)\s*no-transform(?:\s*,|$)/i);
    });
  }
  for (const path of ["/", "/__compression_guard__"]) {
    test(`observability/capabilities/api (default) ${path} opts out`, async () => {
      const response = await capabilities.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control")).toMatch(/(?:^|,)\s*no-transform(?:\s*,|$)/i);
    });
  }
  for (const path of ["/", "/__compression_guard__"]) {
    test(`observability/notifications/api (default) ${path} opts out`, async () => {
      const response = await notifications.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control")).toMatch(/(?:^|,)\s*no-transform(?:\s*,|$)/i);
    });
  }
});

test("job traces and Sync dead-letter previews opt out", async () => {
  for (const router of [jobs, sync]) {
    for (const path of ["/", "/__new_route__"]) {
      const response = await router.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control")).toContain("no-transform");
    }
  }
});

test("health and routing APIs stay eligible for compression", async () => {
  const response = await apiRoutes.request("/health");
  expect(response.status).toBeLessThan(500);
  expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-transform");
});

for (const page of ["jobs", "sync", "logs", "workflows", "capabilities", "notifications"]) {
  test(`${page} payload page opts out`, async () => {
    for (const suffix of ["", "/__new_route__"]) {
      const response = await router.request(`/admin/observability/${page}${suffix}`);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
    }
  });
}

test("metrics page stays eligible for compression", async () => {
  const response = await router.request("/admin/observability/metrics");
  expect(response.status).toBeLessThan(500);
  expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-transform");
});
