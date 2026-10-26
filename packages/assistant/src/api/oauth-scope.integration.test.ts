import { test } from "bun:test";
import { assertAdminMutationsRejectReadOAuth, withAdminOAuth } from "../../../../scripts/fixtures/admin-oauth";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { artifactApi as routes } from "../artifacts/api";

suiteFor(
  "database",
  "nats",
  "valkey",
)("assistant resource OAuth ceiling", () => {
  test("every protected mutation rejects a real read-only user OAuth token", () =>
    withAdminOAuth(async ({ readHeaders }) => {
      await assertAdminMutationsRejectReadOAuth(routes, readHeaders, (path) => !path.startsWith("/admin/"));
    }));
});
