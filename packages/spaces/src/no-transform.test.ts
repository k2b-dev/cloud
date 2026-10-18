import { describe, expect, test } from "bun:test";
import { prepareNoTransformRouterTest } from "../../../scripts/fixtures/no-transform";

prepareNoTransformRouterTest();

const { default: api } = await import("./api/index");
const { default: pages } = await import("./frontend/index");
const { adminPages } = await import("./frontend/index");

describe("compression boundaries", () => {
  for (const path of [
    "/",
    "/overview/search",
    "/space/items/item/detail",
    "/space/items/item/links",
    "/space/items/item/links/link",
    "/calendar",
    "/calendar/overlap",
    "/calendar/__new_route__",
  ]) {
    test(`api ${path} opts out`, async () => {
      const response = await api.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
    });
  }
  for (const path of [
    "/resolve",
    "/overview/work",
    "/overview/activity",
    "/widget/today",
    "/space/settings-context",
    "/space/items/item/invitation-context",
    "/admin/space/access",
    "/admin/__new_route__",
    "/space/items/item/comments",
    "/space/items",
    "/space",
    "/workspace/view",
  ]) {
    test(`api ${path} stays eligible for compression`, async () => {
      const response = await api.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-transform");
    });
  }
  for (const path of ["/", "/space"]) {
    test(`pages ${path} opts out`, async () => {
      const response = await pages.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
    });
  }
  for (const path of ["/"]) {
    test(`adminPages ${path} opts out`, async () => {
      const response = await adminPages.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
    });
  }
});
