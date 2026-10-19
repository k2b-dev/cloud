import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { prepareNoTransformRouterTest } from "../../../scripts/fixtures/no-transform";

prepareNoTransformRouterTest();
const { gridsService } = await import("./service");
const missingForm = spyOn(gridsService.form, "getByPublicToken").mockResolvedValue(null);
const published = await import("./api/custom-app-published-page");
const login = await import("./frontend/custom-app/login");
const missing = spyOn(published, "loadPublishedCustomAppPage").mockResolvedValue(null);
const noLogin = spyOn(login, "customAppPageNeedsLogin").mockResolvedValue(false);
afterAll(() => {
  missing.mockRestore();
  missingForm.mockRestore();
  noLogin.mockRestore();
});

const { default: api } = await import("./api/index");
const { default: pages } = await import("./frontend/index");
const { adminRoutes: adminPages } = await import("./frontend/index");
const { customAppRoutes: publishedApps } = await import("./frontend/index");
const { publicRoutes: publicPages } = await import("./frontend/index");

describe("compression boundaries", () => {
  for (const path of ["/bases", "/records", "/gql", "/workspace", "/forms"]) {
    test(`api/index (default) ${path} opts out`, async () => {
      const response = await api.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control")).toMatch(/(?:^|,)\s*no-transform(?:\s*,|$)/i);
    });
  }
  for (const path of ["/", "/base/table/table"]) {
    test(`frontend/index (default) ${path} opts out`, async () => {
      const response = await pages.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control")).toMatch(/(?:^|,)\s*no-transform(?:\s*,|$)/i);
    });
  }
  for (const path of ["/"]) {
    test(`frontend/index (adminRoutes) ${path} opts out`, async () => {
      const response = await adminPages.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control")).toMatch(/(?:^|,)\s*no-transform(?:\s*,|$)/i);
    });
  }
  for (const path of ["/app"]) {
    test(`frontend/index (customAppRoutes) ${path} opts out`, async () => {
      const response = await publishedApps.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control")).toMatch(/(?:^|,)\s*no-transform(?:\s*,|$)/i);
    });
  }
  for (const path of ["/documents", "/documents/token", "/documents/token/download"]) {
    test(`frontend/index (publicRoutes) ${path} opts out`, async () => {
      const response = await publicPages.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control")).toMatch(/(?:^|,)\s*no-transform(?:\s*,|$)/i);
    });
  }
});

test("public form pages stay eligible for compression beside shared documents", async () => {
  const response = await publicPages.request("/forms/token");
  expect(response.status).toBeLessThan(500);
  expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-transform");
});
