import { test } from "bun:test";
import { assertAdminMutationsRejectReadOAuth, withAdminOAuth } from "../../../../scripts/fixtures/admin-oauth";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import routes from "./index";

suiteFor(
  "database",
  "nats",
  "valkey",
)("ipa-hosts administrator OAuth ceiling", () => {
  test("every admin mutation rejects a real read-only administrator token", () =>
    withAdminOAuth(async ({ readHeaders }) => {
      await assertAdminMutationsRejectReadOAuth(routes, readHeaders);
    }));
});
