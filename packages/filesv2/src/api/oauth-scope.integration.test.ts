import { test } from "bun:test";
import { assertAdminMutationsRejectReadOAuth, withAdminOAuth } from "../../../../scripts/fixtures/admin-oauth";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import routes from "./index";

suiteFor(
  "database",
  "nats",
  "valkey",
)("filesv2 resource OAuth ceiling", () => {
  test("every protected mutation rejects a real read-only user OAuth token", () =>
    withAdminOAuth(async ({ readHeaders }) => {
      await assertAdminMutationsRejectReadOAuth(
        routes,
        readHeaders,
        (path) => !path.startsWith("/admin/") && !path.startsWith("/templates/admin") && !path.startsWith("/wopi/"),
      );
    }));
});
