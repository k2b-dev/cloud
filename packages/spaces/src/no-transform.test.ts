import { describe, expect, test } from "bun:test";
import { prepareNoTransformRouterTest } from "../../../scripts/fixtures/no-transform";

prepareNoTransformRouterTest();

const { default: api } = await import("./api/index");
const { default: pages } = await import("./frontend/index");
const { adminPages } = await import("./frontend/index");

describe("compression boundaries", () => {
  for (const path of [
    "/resolve",
    "/resolve/__new_route__",
    "/items/item",
    "/items/item/__new_route__",
    "/space/items",
    "/space/items/__new_route__",
    "/space/items/item",
    "/space/items/item/__new_route__",
    "/space/items/item/comments",
    "/space/items/item/invitation-context",
    "/space/items/item/invitation-context/__new_route__",
    "/space/settings-context",
    "/space/settings-context/__new_route__",
    "/workspace/view",
    "/workspace/view/__new_route__",
    "/",
    "/overview/search",
    "/overview/search/__new_route__",
    "/space/items/item/detail",
    "/space/items/item/detail/__new_route__",
    "/space/items/item/links",
    "/space/items/item/links/__new_route__",
    "/space/items/item/links/link",
    "/space/items/item/links/link/__new_route__",
    "/calendar",
    "/calendar/__new_route__",
    "/calendar/overlap",
    "/calendar/overlap/__new_route__",
  ]) {
    test(`api ${path} opts out`, async () => {
      const response = await api.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
    });
  }
  for (const path of ["/overview/work", "/overview/activity", "/widget/today", "/admin/space/access", "/admin/__new_route__", "/space"]) {
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
