import { afterAll, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { assertAdminMutationsRejectReadOAuth, withAdminOAuth } from "../../../scripts/fixtures/admin-oauth";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import { registerSsrTestPlugin } from "../../ui/test/ssr-test-plugin";
import "../../../scripts/fixtures/authorization-preload";

const root = mkdtempSync(join(tmpdir(), "gateway-admin-routes-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { router } = await import("./router");

// Use the mounted handlers without SSR runtime/settings middleware: the exact
// route-level authentication and API sub-router guards still run unchanged.
const routes = new Hono();
for (const { method, path, handler } of router.routes) {
  if (method !== "ALL" || path.startsWith("/api/")) routes.on(method, path, handler);
}

suiteFor(
  "database",
  "nats",
  "valkey",
)("Gateway Ops administrator OAuth ceiling", () => {
  test("API mutations and the SSR schedule action reject a real read-only administrator token", () =>
    withAdminOAuth(async ({ readHeaders }) => {
      await assertAdminMutationsRejectReadOAuth(routes, readHeaders);
    }));
});
