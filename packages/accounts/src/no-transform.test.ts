import { describe, expect, test } from "bun:test";
import { prepareNoTransformRouterTest } from "../../../scripts/fixtures/no-transform";

prepareNoTransformRouterTest();

const { default: api } = await import("./api/index");
const { default: pages } = await import("./frontend/index");

describe("compression boundaries", () => {
  for (const path of [
    "/service-accounts",
    "/service-accounts/__new_route__",
    "/users",
    "/users/__new_route__",
    "/audit",
    "/audit/__new_route__",
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
  for (const path of ["/groups", "/widget/admin-queue"]) {
    test(`api ${path} stays eligible for compression`, async () => {
      const response = await api.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-transform");
    });
  }
  for (const path of [
    "/",
    "/agents",
    "/agents/__new_route__",
    "/groups/group",
    "/groups/group/__new_route__",
    "/service-accounts",
    "/service-accounts/__new_route__",
    "/users",
    "/users/user",
    "/users/__new_route__",
    "/duplicate-emails",
    "/duplicate-emails/__new_route__",
    "/deleted-accounts",
    "/deleted-accounts/__new_route__",
    "/reminders",
    "/reminders/__new_route__",
    "/audit",
    "/audit/__new_route__",
    "/requests",
    "/requests/__new_route__",
    "/notifications",
    "/notifications/batch",
  ]) {
    test(`pages ${path} opts out`, async () => {
      const response = await pages.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").toContain("no-transform");
    });
  }
  for (const path of ["/groups"]) {
    test(`pages ${path} stays eligible for compression`, async () => {
      const response = await pages.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-transform");
    });
  }
});
