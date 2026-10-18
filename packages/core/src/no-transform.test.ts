import { describe, expect, test } from "bun:test";
import { type AuthContext, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import { prepareNoTransformRouterTest } from "../../../scripts/fixtures/no-transform";

prepareNoTransformRouterTest();
const { createPagesRouter } = await import("./pages/create");
const { aiChatTaskRoutes } = await import("./ai-chat-task-routes");
const pages = new Hono<AuthContext>().use("*", middleware.runtime()).use("*", middleware.settings()).route("/", createPagesRouter());

describe("Core compression boundaries", () => {
  for (const path of [
    "/me/notifications/history",
    "/me/notifications/history/__new_route__",
    "/me/approvals",
    "/me/approvals/__new_route__",
    "/admin/outgoing-mail",
    "/admin/outgoing-mail/__new_route__",
    "/admin/settings",
    "/admin/settings?tab=ai-usage",
    "/admin/settings?tab=ai-projects",
    "/admin/settings?tab=ai-skills",
    "/admin/settings?tab=ai-jobs",
    "/admin/settings?tab=ai-providers",
    "/admin/settings/__new_route__",
  ]) {
    test(`${path} opts out before authentication`, async () => {
      const response = await pages.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control")).toContain("no-transform");
    });
  }
  test("AI tasks opt out at the owning router", async () => {
    for (const path of ["/tasks", "/__new_route__"]) {
      const response = await aiChatTaskRoutes.request(path);
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get("Cache-Control")).toContain("no-transform");
    }
  });
});

test("profile, access and notification settings pages stay eligible for compression", async () => {
  for (const path of ["/me", "/me/access", "/me/security", "/me/notifications"]) {
    const response = await pages.request(path);
    expect(response.status).toBeLessThan(500);
    expect(response.headers.get("Cache-Control") ?? "").not.toContain("no-transform");
  }
});
