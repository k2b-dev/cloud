import { expect, spyOn, test } from "bun:test";
import { auth, type AuthContext, middleware } from "@k2b/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";
import { prepareNoTransformRouterTest } from "../../../../../../scripts/fixtures/no-transform";

// The App credentials page moved into each app's keys; its address keeps working and says where the content is now.
prepareNoTransformRouterTest();
const pass: MiddlewareHandler<AuthContext> = async (_c, next) => next();
const requireRole = spyOn(auth, "requireRole").mockReturnValue(pass);
const { createPagesRouter } = await import("../../create");
const pages = new Hono<AuthContext>().use("*", middleware.runtime()).use("*", middleware.settings()).route("/", createPagesRouter());
requireRole.mockRestore();

test("the old App credentials address opens the Apps page with its hint", async () => {
  const response = await pages.request("/admin/app-credentials");
  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe("/admin/apps?moved=credentials");
});
