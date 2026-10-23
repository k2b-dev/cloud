import { expect, test } from "bun:test";
import { type AuthContext, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import { prepareNoTransformRouterTest } from "../../../../../../scripts/fixtures/no-transform";

prepareNoTransformRouterTest();
const { createPagesRouter } = await import("../../create");
const pages = new Hono<AuthContext>().use("*", middleware.runtime()).use("*", middleware.settings()).route("/", createPagesRouter());

// Core registers each admin page explicitly; a page file alone is not reachable.
test("the places and maps page is registered behind the admin guard,", async () => {
  const page = await pages.request("/admin/places-and-maps");
  expect([302, 401, 403]).toContain(page.status);
});
