import { test } from "bun:test";
import { assertAdminMutationsRejectReadOAuth, withAdminOAuth } from "../../../../scripts/fixtures/admin-oauth";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import "../frontend/[id]/_components/detail/ssr-test-plugin";

const { default: routes } = await import("./index");

suiteFor(
  "database",
  "nats",
  "valkey",
)("notebooks administrator OAuth ceiling", () => {
  test("every admin mutation rejects a real read-only administrator token", () =>
    withAdminOAuth(async ({ readHeaders }) => {
      await assertAdminMutationsRejectReadOAuth(routes, readHeaders, (path) => path.startsWith("/admin/"));
    }));
});
