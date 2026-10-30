import { expect, spyOn, test } from "bun:test";
import { auth, type AuthContext } from "@k2b/cloud/server";
import type { MiddlewareHandler } from "hono";
import { prepareNoTransformRouterTest } from "../../../scripts/fixtures/no-transform";

// The apps table moved to Administration › Apps; its old address keeps working and says where it is now.
prepareNoTransformRouterTest();
const pass: MiddlewareHandler<AuthContext> = async (_c, next) => next();
const requireRole = spyOn(auth, "requireRole").mockReturnValue(pass);
const { router } = await import("./router");
requireRole.mockRestore();

test("the old Gateway › Apps address opens Administration › Apps with its hint", async () => {
  const response = await router.request("/admin/observability/gateway");
  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe("/admin/apps?moved=gateway");
});
