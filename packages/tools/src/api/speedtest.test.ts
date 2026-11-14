import { describe, expect, test } from "bun:test";
import { DEFAULT_SERVER } from "@k2b/speedtest";
import { generateSpecs } from "hono-openapi";
import { createSpeedtestRoutes } from "./speedtest";

const router = createSpeedtestRoutes(async () => ({ server: DEFAULT_SERVER, enabled: false }));
describe("speedtest migration boundary", () => {
  test("all old URLs return bounded no-store 410, with no redirect or transfer", async () => {
    for (const [method, path] of [
      ["GET", "ping"],
      ["GET", "download?size=209715200"],
      ["POST", "upload"],
      ["GET", "cli"],
      ["GET", "cli.py"],
    ]) {
      const response = await router.request(`/${path}`, {
        method,
        headers: { Authorization: "Bearer test-secret", Cookie: "session=test-cookie" },
      });
      expect(response.status).toBe(410);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      const text = await response.text();
      expect(text).toContain("moved");
      expect(text.length).toBeLessThan(1024);
      expect(text).not.toMatch(/test-secret|test-cookie|ReadableStream|fetch\(/);
    }
  });
  test("public configuration exposes only the server and operator switch", async () => {
    const response = await router.request("/config");
    expect(await response.json()).toEqual({ server: DEFAULT_SERVER, enabled: false });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

test("OpenAPI includes public configuration and deprecated migration endpoints", async () => {
  const spec = await generateSpecs(router, { excludeStaticFile: false });
  expect(spec.paths?.["/config"]?.get?.responses?.["200"]).toBeDefined();
  for (const path of ["/ping", "/download", "/upload", "/cli", "/cli.py"]) {
    const operation = path === "/upload" ? spec.paths?.[path]?.post : spec.paths?.[path]?.get;
    expect(operation?.deprecated).toBe(true);
    expect(operation?.responses?.["410"]).toBeDefined();
  }
});
